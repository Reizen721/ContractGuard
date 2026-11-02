import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { analyzeCompatibility, ENGINE_VERSION } from '../../packages/core/dist/index.js';
import { createApp } from '../../apps/api/dist/app.js';

// Hand-labelled synthetic scenarios, executed sequentially. This suite checks
// functionality and entry-point agreement, not real-world precision or recall.
export function parseOutputDirectory(args) {
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output-dir'),
    'Usage: node <suite-script> [--output-dir <directory>]');
  return args.length ? resolve(args[1]) : undefined;
}

export async function runAcceptanceSuite({ fixtureDirectory, manifests, expectedIds, title, policyId, outputDirectory, businessScenarios = false }) {
  const execute = promisify(execFile);
  const root = resolve(import.meta.dirname, '../..');
  const fixtures = join(root, fixtureDirectory);
  const cases = [];
  for (const name of manifests) {
    cases.push(...JSON.parse(await readFile(join(fixtures, name), 'utf8')));
  }
  assert.deepEqual(cases.map((item) => item.id), expectedIds, 'Unexpected scenario count or order');

  const temporary = await mkdtemp(join(tmpdir(), 'contractguard-acceptance-v13-'));
  const dataDirectory = join(temporary, 'analyses');
  const policy = { schemaVersion: 1, id: policyId };
  const policyPath = join(temporary, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
  const report = { suite: title, engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(), nodeVersion: process.version, synthetic: true,
    cases: [], historyAfterRestart: null };
  let server;
  let baseUrl;

  async function startServer() {
    server = createApp({ dataDirectory, serveWeb: false, rulePolicy: policy,
      aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } }).listen(0, '127.0.0.1');
    await new Promise((ready, reject) => { server.once('listening', ready); server.once('error', reject); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stopServer() {
    if (server?.listening) await new Promise((closed, reject) => server.close((error) => error ? reject(error) : closed()));
  }

  async function request(path, init) {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
    return response;
  }

  function semantics(result) {
    const { engineVersion, policy, source, score, compatible, summary, changes, coverage } = result;
    // Optional undefined properties do not exist on the JSON wire; compare the
    // same JSON representation without dropping any defined finding/evidence.
    return JSON.parse(JSON.stringify({ engineVersion, policy, source, score, compatible, summary, changes, coverage }));
  }

  function findingLabels(findings, exactLocations) {
    return findings.map(({ ruleId, severity, location }) => JSON.stringify(exactLocations ? [ruleId, severity, location] : [ruleId, severity])).sort();
  }

  async function load(item, side) {
    const descriptor = item[side];
    const files = [];
    for (const path of descriptor.files) files.push({ path, content: await readFile(join(fixtures, item.id, side, path), 'utf8') });
    return { kind: 'bundle', entry: descriptor.entry, files };
  }

  async function cli(item, extra = []) {
    const command = [join(root, 'apps/cli/dist/index.js'), 'compare',
      join(fixtures, item.id, 'baseline', item.baseline.entry),
      join(fixtures, item.id, 'candidate', item.candidate.entry),
      '--bundle', '--format', 'json', '--policy', policyPath, ...extra];
    try {
      const result = await execute(process.execPath, command, { cwd: root, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  function checkExpected(item, result) {
    assert.equal(result.compatible, item.expect.compatible, 'Unexpected compatible flag');
    assert.equal(result.coverage?.status, item.expect.coverage, 'Unexpected analysis coverage');
    if (businessScenarios) {
      assert.ok(item.expect.findings.every((finding) => typeof finding.location === 'string'), 'Composite expectations need precise finding locations');
      assert.ok(item.expect.counterexamples?.length >= 3, 'Business scenarios need independent interaction explanations');
      assert.ok(item.expect.controls?.length > 0, 'Business scenarios need unchanged control operations');
      assert.ok(result.source.old.bundle.files.length >= 4 && result.source.new.bundle.files.length >= 4, 'Business scenarios require at least four actual dependency files per side');
    }
    assert.deepEqual(findingLabels(result.changes, businessScenarios), findingLabels(item.expect.findings, businessScenarios), 'Findings differ from the hand-labelled expectation');
    const expectedSummary = { total: item.expect.findings.length, breaking: 0, potentiallyBreaking: 0, nonBreaking: 0, info: 0 };
    const summaryFields = { breaking: 'breaking', 'potentially-breaking': 'potentiallyBreaking', 'non-breaking': 'nonBreaking', info: 'info' };
    for (const finding of item.expect.findings) expectedSummary[summaryFields[finding.severity]] += 1;
    assert.deepEqual(result.summary, expectedSummary, 'Summary counters differ from the independently labelled findings');
    for (const code of item.expect.coverageCodes ?? []) {
      assert.ok(result.coverage.warnings.some((warning) => warning.code === code), `Missing coverage warning ${code}`);
    }
    if (item.expect.coverage === 'complete') {
      assert.deepEqual(result.coverage.warnings, [], 'Complete coverage cannot contain warnings');
      assert.equal(result.coverage.truncated, false);
    }
    for (const expected of item.expect.sourceLocations ?? []) {
      const finding = result.changes.find((change) => change.ruleId === expected.ruleId);
      assert.ok(finding, `Missing sourced finding ${expected.ruleId}`);
      assert.deepEqual(finding.sourceLocations, { old: expected.old, new: expected.new }, 'Finding points at the wrong original file/fragment');
    }
    for (const expected of item.expect.sourceChecks ?? []) {
      const finding = result.changes.find((change) => change.ruleId === expected.ruleId && change.location.includes(expected.locationIncludes));
      assert.ok(finding, `Missing sourced finding ${expected.ruleId} at ${expected.locationIncludes}`);
      assert.deepEqual(finding.sourceLocations, { old: expected.old, new: expected.new }, 'Composite finding has incorrect source evidence');
    }
    for (const control of item.expect.controls ?? []) {
      assert.ok(!result.changes.some((change) => change.location.startsWith(control.locationPrefix)), `Unchanged control reported a change: ${control.locationPrefix}`);
    }
  }

  function checkFileFingerprints(result, baseline, candidate) {
    for (const [side, bundle] of [['old', baseline], ['new', candidate]]) {
      for (const dependency of result.source[side].bundle.files) {
        const provided = bundle.files.find((file) => file.path === dependency.path);
        assert.ok(provided, `Dependency ${dependency.path} was not explicitly supplied`);
        assert.deepEqual(dependency.fingerprint, { algorithm: 'sha256', value: createHash('sha256').update(provided.content, 'utf8').digest('hex') });
      }
    }
  }

  function exportText(body, format) {
    return format === 'markdown' ? body.replace(/\\([\\`*_{}\[\]<>#+.!|~-])/g, '$1')
      : body.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  async function saveEvidence(id, value) {
    if (outputDirectory) await writeFile(join(outputDirectory, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  const savedIds = [];
  try {
    await startServer();
    for (const item of cases) {
      const started = performance.now();
      const row = { id: item.id, title: item.title, scenario: item.scenario, expected: item.expect,
        status: 'failed', checks: [], elapsedMs: 0 };
      const evidence = { id: item.id, title: item.title, expected: item.expect };
      try {
        const baseline = await load(item, 'baseline');
        const candidate = await load(item, 'candidate');
        row.fixtureFingerprint = createHash('sha256').update(JSON.stringify({ baseline, candidate })).digest('hex');
        const beforeHistory = (await (await request('/api/analyses')).json()).analyses.length;
        let core;
        let coreError;
        try { core = analyzeCompatibility(baseline, candidate, { policy }); } catch (error) { coreError = error; }
        if (core) evidence.core = core;
        const response = await request('/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseline, candidate, baselineName: `${item.id}/baseline/${item.baseline.entry}`,
            candidateName: `${item.id}/candidate/${item.candidate.entry}` }) });
        const api = await response.json();
        if (response.status === 201 && typeof api.id === 'string') savedIds.push({ id: api.id, expected: semantics(api) });
        const command = await cli(item);
        evidence.api = { status: response.status, body: api };
        evidence.cli = command;
        if (item.expect.errorCode) {
          assert.ok(coreError, 'Core unexpectedly accepted an invalid contract package');
          assert.equal(coreError.code, item.expect.errorCode);
          if (item.expect.missingFile) assert.equal(coreError.details?.missingFile, item.expect.missingFile);
          evidence.core = { errorCode: coreError.code, message: coreError.message, details: coreError.details };
          row.checks.push('core rejects input');
          assert.equal(response.status, 400);
          assert.equal(api.error?.code, item.expect.errorCode);
          row.checks.push('HTTP 400 with expected code');
          assert.equal(command.exitCode, 1);
          assert.equal(command.stdout.trim(), '', 'Invalid inputs must not emit a successful JSON report');
          assert.match(command.stderr, /ContractGuard error:/);
          row.checks.push('CLI exits 1 without report');
          assert.equal((await (await request('/api/analyses')).json()).analyses.length, beforeHistory);
          row.checks.push('no failed analysis persisted');
          row.observed = { errorCode: coreError.code, apiStatus: response.status, cliExitCode: command.exitCode };
        } else {
          if (coreError) throw coreError;
          checkExpected(item, core);
          checkFileFingerprints(core, baseline, candidate);
          row.checks.push('independent semantic expectation');
          if (businessScenarios) {
            const reordered = analyzeCompatibility({ ...baseline, files: [...baseline.files].reverse() },
              { ...candidate, files: [...candidate.files].reverse() }, { policy });
            assert.deepEqual(semantics(reordered), semantics(core), 'Selecting files in a different order changed the result');
            row.checks.push('exact locations, controls, source fingerprints and manifest order');
          }
          assert.equal(response.status, 201, JSON.stringify(api));
          assert.deepEqual(semantics(api), semantics(core), 'API/core semantic mismatch');
          row.checks.push('API/core equality');
          const cliResult = JSON.parse(command.stdout);
          assert.equal(command.exitCode, item.expect.findings.some((finding) => finding.severity === 'breaking') ? 2 : 0);
          assert.deepEqual(semantics(cliResult), semantics(core), 'CLI/core semantic mismatch');
          row.checks.push('CLI/core equality and default gate');
          const strict = await cli(item, ['--fail-on', 'never', '--fail-on-incomplete']);
          assert.equal(strict.exitCode, item.expect.coverage === 'partial' ? 2 : 0);
          assert.deepEqual(semantics(JSON.parse(strict.stdout)), semantics(core));
          row.checks.push('independent incomplete gate');
          const stored = await (await request(`/api/analyses/${api.id}`)).json();
          assert.deepEqual(semantics(stored), semantics(core));
          assert.equal((await (await request('/api/analyses')).json()).analyses.length, beforeHistory + 1);
          row.checks.push('saved analysis round trip');
          for (const format of ['markdown', 'html']) {
            const exported = await request(`/api/analyses/${api.id}/report?format=${format}`);
            assert.equal(exported.status, 200);
            const body = await exported.text();
            assert.match(body, /Analysis coverage/);
            assert.match(body, new RegExp(`Status: ${core.coverage.status}`));
            assert.ok(body.includes(policyId), 'Export omits applied policy');
            assert.doesNotMatch(body, /undefined|\[object Object\]/);
            if (businessScenarios) {
              const text = exportText(body, format);
              for (const finding of item.expect.findings) assert.ok(text.includes(finding.ruleId), `Export omits ${finding.ruleId}`);
              for (const code of item.expect.coverageCodes ?? []) assert.ok(text.includes(code), `Export omits coverage code ${code}`);
              for (const check of item.expect.sourceChecks ?? []) {
                for (const source of [check.old, check.new]) if (source) assert.ok(text.includes(`${source.file}${source.pointer}`), 'Export omits original source reference');
              }
            }
            if (outputDirectory) await writeFile(join(outputDirectory, `${item.id}.${format === 'markdown' ? 'md' : 'html'}`), body);
          }
          row.checks.push('Markdown and HTML exports');
          row.observed = { score: core.score, compatible: core.compatible, summary: core.summary, coverage: core.coverage,
            cliExitCode: command.exitCode, strictIncompleteExitCode: strict.exitCode,
            dependencyFiles: { old: core.source.old.bundle.files.length, new: core.source.new.bundle.files.length } };
        }
        row.status = 'passed';
      } catch (error) {
        evidence.failure = error instanceof Error ? error.message : String(error);
        row.error = evidence.failure.split('\n')[0].slice(0, 240);
      }
      row.elapsedMs = Math.round(performance.now() - started);
      report.cases.push(row);
      await saveEvidence(item.id, evidence);
      process.stdout.write(`${row.status === 'passed' ? 'PASS' : 'FAIL'} ${item.id} ${item.title}${row.error ? `: ${row.error}` : ''}\n`);
    }
    // Restart the real HTTP app against only this suite's temporary history.
    await stopServer();
    await startServer();
    try {
      const history = (await (await request('/api/analyses')).json()).analyses;
      assert.equal(history.length, savedIds.length, 'History count changed after restart');
      for (const saved of savedIds) {
        const restored = await (await request(`/api/analyses/${saved.id}`)).json();
        assert.deepEqual(semantics(restored), saved.expected, 'Restart lost findings, coverage or source metadata');
      }
      report.historyAfterRestart = { status: 'passed', analyses: history.length };
    } catch (error) {
      report.historyAfterRestart = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await stopServer();
    // This is precisely the directory created by this invocation, not a selected
    // workspace or user history path. Exported evidence is deliberately retained.
    await rm(temporary, { recursive: true, force: true });
  }

  report.passed = report.cases.filter((item) => item.status === 'passed').length;
  report.failed = report.cases.length - report.passed;
  if (outputDirectory) {
    await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    const lines = [`# ${title}`, '',
      `Engine ${report.engineVersion} · Node ${report.nodeVersion} · ${report.generatedAt}`, '',
      '固定标签的合成案例；通过结果不等同于真实数据准确率或浏览器验收。所有场景依次执行 Core、HTTP 和 CLI；AI 关闭，无云端调用。', '',
      '| 编号 | 案例 | 结果 | 观察 |', '| --- | --- | --- | --- |',
      ...report.cases.map((item) => `| ${item.id} | ${item.title} | ${item.status} | ${item.error?.replaceAll('|', '\\|') ?? (item.observed.errorCode ?? `${item.observed.summary.total} findings; ${item.observed.coverage.status}; score ${item.observed.score}`)} |`), '',
      `通过 ${report.passed}/${cases.length}，失败 ${report.failed}。服务重启后恢复 ${report.historyAfterRestart?.analyses ?? 0} 份有效历史记录。`, '',
      '每个 case JSON 包含期望与实际 Core/API/CLI 证据；有效案例另有 Markdown、HTML 导出。', ''];
    await writeFile(join(outputDirectory, 'README.md'), lines.join('\n'));
  }
  process.stdout.write(`Sequential acceptance: ${report.passed}/${cases.length} passed, ${report.failed} failed; ${report.historyAfterRestart?.analyses ?? 0} analyses restored after restart.\n`);
  return { report, exitCode: report.failed || report.historyAfterRestart?.status !== 'passed' ? 1 : 0 };
}
