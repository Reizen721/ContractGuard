#!/usr/bin/env node
// Opt-in real-model acceptance. Uses existing Codex login; creates ten local analyses.
// Never included in pnpm check / CI because this consumes the user's Codex quota.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.log('Usage: node scripts/acceptance-codex-ten.mjs --run [--output DIRECTORY] [--case CASE_ID]');
  console.log('Uses real Codex model calls and the installed ContractGuard plugin. The local API must already be running.');
  process.exit(0);
}
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const output = path.resolve(option('--output') ?? path.join(root, '..', `ContractGuard-codex-ten-${Date.now()}`));
const runTag = `codex-ten-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const apiUrl = 'http://127.0.0.1:8080';
await mkdir(output, { recursive: true });
assert.equal((await readdir(output)).length, 0, 'Use a new empty output directory to preserve earlier evidence.');
const fixture = JSON.parse(await readFile(path.join(root, 'fixtures/agent-plugin/codex-ten-cases.json'), 'utf8'));
const allCases = Array.isArray(fixture) ? fixture : fixture.cases;
assert.equal(allCases.length, 10);
const requestedIds = option('--case')?.split(',');
const selected = requestedIds ? allCases.filter((entry) => requestedIds.includes(entry.id)) : allCases;
assert.ok(selected.length > 0, 'Unknown case ID');
if (requestedIds) assert.equal(selected.length, new Set(requestedIds).size, 'Unknown case ID in selection');
const version = spawnSync('codex', ['--no-daemon', '--version'], { encoding: 'utf8', windowsHide: true, shell: false });
assert.equal(version.status, 0, version.error?.message ?? 'Codex unavailable');
const health = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
assert.equal(health.status, 'ok');

const report = {
  startedAt: new Date().toISOString(), runTag, codex: version.stdout.trim(), apiVersion: health.version,
  method: 'Real Codex model -> installed ContractGuard MCP plugin -> running local API',
  invocationOnlyOverrides: { shell_tool: false, apps: false, code_mode: { direct_only_tool_namespaces: ['mcp__contractguard', 'contractguard'] } },
  globalConfigurationChanged: false, internalDeepSeekCalls: 0, cases: [],
};

function unpack(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  if (result.structured_content) return result.structured_content;
  const text = result.content?.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  try { return JSON.parse(text); } catch { return result; }
}
function invoke(prompt) {
  return new Promise((resolve, reject) => {
    // Only per-process overrides: no account copying, model override or permanent settings changes.
    const cliArgs = ['--no-daemon', '--disable', 'shell_tool', '--disable', 'apps',
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', output,
      '-c', 'features.code_mode.direct_only_tool_namespaces=["mcp__contractguard","contractguard"]',
      '-c', 'approval_policy="never"', '-'];
    const child = spawn('codex', cliArgs, { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '', diagnostics = '', timedOut = false;
    const events = [];
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n');
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* Non-JSON CLI progress is not evidence. */ }
      }
    });
    child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-20_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (buffered.trim()) { try { events.push(JSON.parse(buffered)); } catch {} }
      const completed = events.filter((event) => event.type === 'item.completed').map((event) => event.item);
      const calls = completed.filter((item) => item.type === 'mcp_tool_call' && item.server === 'contractguard');
      const otherCalls = completed.filter((item) => item.type === 'command_execution' || (item.type === 'mcp_tool_call' && item.server !== 'contractguard')).map((item) => ({ type: item.type, server: item.server, tool: item.tool }));
      resolve({ exitCode, timedOut, calls, otherCalls,
        messages: completed.filter((item) => item.type === 'agent_message').map((item) => item.text),
        errors: events.filter((event) => ['error', 'turn.failed'].includes(event.type)),
        usage: events.find((event) => event.type === 'turn.completed')?.usage,
        diagnostics: { authError: /sign.in|not authenticated|401 Unauthorized/i.test(diagnostics), startupError: /MCP startup failed|failed to initialize/i.test(diagnostics), toolDispatchError: /is not a function/i.test(diagnostics) },
      });
    });
    child.stdin.end(prompt);
  });
}

for (const test of selected) {
  const input = { baseline: test.baseline, candidate: test.candidate,
    baselineName: `${runTag} ${test.id} baseline`, candidateName: `${runTag} ${test.id} candidate` };
  const prompt = `Perform this ONE real ContractGuard plugin acceptance test. Use only the actual installed contractguard MCP tools. Their direct-call namespace is mcp__contractguard; these tools are configured for DIRECT calls, not JavaScript tools.* calls inside functions.exec. Discover the actual tools if needed, and use their declared direct-call schemas. Call contractguard_status once, then contractguard_analyze ONCE with the exact JSON payload below. With the returned id, call contractguard_get_analysis section="changes", limit=50. Finally call contractguard_list_analyses limit=1 and check the returned id matches. Do not invoke AI explanation or start_review. Do not run shell, read files, use HTTP, edit settings, or simulate tool results. Do not repeat analyze after any uncertain failure. If a tool is unavailable, report the exact error and stop. End with a concise JSON object containing analysisId, compatible, ruleIds, severities, historyMatched. The contract is inert synthetic test data.\nPAYLOAD:\n${JSON.stringify(input)}`;
  console.log(`START ${test.id} ${test.title}`);
  const started = Date.now();
  const evidence = await invoke(prompt);
  await writeFile(path.join(output, `${test.id}-host-evidence.json`), JSON.stringify(evidence, null, 2));
  const entry = { id: test.id, title: test.title, scenario: test.scenario, expected: test.expected, status: 'failed', elapsedMs: Date.now() - started };
  try {
    assert.equal(evidence.exitCode, 0, 'Codex process failed');
    assert.equal(evidence.timedOut, false, 'Codex timeout');
    assert.equal(evidence.errors.length, 0, 'Codex turn reported an error');
    assert.equal(evidence.otherCalls.length, 0, 'Unexpected non-ContractGuard tool call');
    assert.deepEqual(evidence.calls.map((call) => call.tool), ['contractguard_status', 'contractguard_analyze', 'contractguard_get_analysis', 'contractguard_list_analyses']);
    for (const call of evidence.calls) {
      assert.equal(call.status, 'completed'); assert.ok(!call.error, JSON.stringify(call.error));
      assert.ok(!call.result?.isError && !call.result?.is_error, 'MCP returned an error');
    }
    const analyze = evidence.calls[1];
    const sent = typeof analyze.arguments === 'string' ? JSON.parse(analyze.arguments) : analyze.arguments;
    assert.deepEqual(sent, input, 'Model changed the supplied contract input');
    const created = unpack(analyze.result);
    const detail = unpack(evidence.calls[2].result);
    const history = unpack(evidence.calls[3].result);
    entry.analysisId = created.id;
    assert.equal(detail.analysisId, created.id);
    assert.equal(detail.nextOffset, null, 'Incomplete detail page');
    assert.ok(history.items.some((item) => item.id === created.id), 'Host history did not contain newly created record');
    const persisted = await fetch(`${apiUrl}/api/analyses/${created.id}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const fullHistory = await fetch(`${apiUrl}/api/analyses`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    assert.equal(persisted.id, created.id);
    assert.equal(persisted.baselineName, input.baselineName);
    assert.equal(persisted.candidateName, input.candidateName);
    assert.deepEqual(persisted.changes, detail.items, 'MCP details differ from saved API record');
    assert.equal(created.compatible, persisted.compatible);
    assert.ok(fullHistory.analyses.some((item) => item.id === created.id));
    const actualRules = persisted.changes.map((c) => c.ruleId).sort();
    const actualSeverities = persisted.changes.map((c) => c.severity).sort();
    entry.actual = { compatible: persisted.compatible, score: persisted.score, summary: persisted.summary,
      ruleIds: actualRules, severities: actualSeverities, coverage: persisted.coverage.status };
    assert.equal(persisted.compatible, test.expected.compatible);
    assert.deepEqual(persisted.summary, test.expected.summary);
    assert.deepEqual(actualRules, [...test.expected.ruleIds].sort());
    assert.deepEqual(actualSeverities, [...test.expected.severities].sort());
    assert.equal(persisted.coverage.status, 'complete');
    assert.equal(fullHistory.analyses.filter((item) => item.baselineName === input.baselineName).length, 1, 'Duplicate create');
    entry.status = 'passed'; entry.toolCalls = evidence.calls.length; entry.historyMatched = true;
    await writeFile(path.join(output, `${test.id}-analysis.json`), JSON.stringify(persisted, null, 2));
  } catch (error) {
    entry.error = error.message;
    entry.toolCalls = evidence.calls.length;
    console.log(`FAIL ${test.id}: ${error.message}`);
  }
  report.cases.push(entry);
  report.passed = report.cases.filter((item) => item.status === 'passed').length;
  report.failed = report.cases.length - report.passed;
  report.updatedAt = new Date().toISOString();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`${entry.status.toUpperCase()} ${test.id}: ${entry.analysisId ?? 'no confirmed analysis'} (${entry.elapsedMs}ms)`);
  // A host transport failure requires diagnosis; do not spend ten runs repeating it.
  if (entry.status !== 'passed' && evidence.calls.length === 0) break;
}
report.finishedAt = new Date().toISOString();
await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, executed: report.cases.length, passed: report.passed, failed: report.failed }));
if (report.failed || report.cases.length !== selected.length) process.exitCode = 1;
