import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { analyzeRelease, ENGINE_VERSION } from '../packages/core/dist/index.js';

// Scope comparison on four intentionally small synthetic cases. This is not an
// accuracy or performance ranking; only ContractGuard receives consumer evidence.
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  assert.ok(['--oasdiff', '--openapi-diff-jar', '--output'].includes(key), 'Usage: node scripts/compare-engines-v14.mjs --oasdiff <executable> --openapi-diff-jar <jar> --output <directory>');
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--') && !options[key], `Missing or duplicate argument: ${key}`);
  options[key] = resolve(args[index + 1]);
}
assert.equal(Object.keys(options).length, 3, 'Supply --oasdiff, --openapi-diff-jar and --output. The script never installs or downloads tools.');
const root = resolve(import.meta.dirname, '..');
const fixtures = join(root, 'fixtures', 'engine-comparison');
const output = options['--output'];
const working = join(output, 'tool-workdir');
await mkdir(working, { recursive: true });
for (const key of ['--oasdiff', '--openapi-diff-jar']) assert.ok((await stat(options[key])).isFile(), `${key} must name an existing regular file.`);
const execute = promisify(execFile);
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('OASDIFF_')));
const config = join(working, 'oasdiff-empty.yaml');
await writeFile(config, '{}\n');

async function run(executable, arguments_) {
  const command = { executable, arguments: arguments_ };
  try {
    const result = await execute(executable, arguments_, { cwd: working, env: childEnvironment, windowsHide: true, shell: false, timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
    return { ...command, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    return { ...command, exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function json(path, data) { await writeFile(path, `${JSON.stringify(data, null, 2)}\n`); }
async function transcript(directory, label, result) {
  await json(join(directory, `${label}.command.json`), { executable: result.executable, arguments: result.arguments, exitCode: result.exitCode });
  await writeFile(join(directory, `${label}.stdout.txt`), result.stdout);
  await writeFile(join(directory, `${label}.stderr.txt`), result.stderr);
}
const oasVersion = await run(options['--oasdiff'], ['--version']);
const openapiVersion = await run('java', ['-jar', options['--openapi-diff-jar'], '--version']);
const javaVersion = await run('java', ['-version']);
for (const result of [oasVersion, openapiVersion, javaVersion]) assert.equal(result.exitCode, 0, 'Tool version command failed.');
await transcript(output, 'oasdiff-version', oasVersion);
await transcript(output, 'openapi-diff-version', openapiVersion);
await transcript(output, 'java-version', javaVersion);
const manifestPath = join(fixtures, 'cases.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.deepEqual(manifest.map((item) => item.id), ['unchanged-contract-response-regression', 'request-minimum-tightened', 'unchanged-contract-positive-control', 'missing-candidate-evidence']);
const result = {
  title: 'ContractGuard V1.4 consumer-evidence scope comparison', startedAt: new Date().toISOString(),
  synthetic: true, broadAccuracyBenchmark: false,
  note: 'All engines receive the same OpenAPI pair. Only ContractGuard receives additional consumer-owned assertions and supplied examples. A difference in evidence scope is not a missed static change by the other tools.',
  environment: { platform: process.platform, architecture: process.arch, nodeVersion: process.version, java: javaVersion.stderr.trim() || javaVersion.stdout.trim() },
  tools: {
    contractguard: { version: ENGINE_VERSION, entry: 'packages/core/dist/index.js', entrySha256: await sha256(join(root, 'packages/core/dist/index.js')) },
    oasdiff: { versionOutput: oasVersion.stdout.trim(), path: options['--oasdiff'], sha256: await sha256(options['--oasdiff']) },
    openapiDiff: { versionOutput: openapiVersion.stdout.trim(), path: options['--openapi-diff-jar'], sha256: await sha256(options['--openapi-diff-jar']) },
  },
  manifestSha256: await sha256(manifestPath), cases: [],
};
for (const scenario of manifest) {
  const directory = join(output, scenario.id);
  await mkdir(directory, { recursive: true });
  const paths = {};
  const hashes = {};
  for (const key of ['baseline', 'candidate', 'evidence']) {
    assert.match(scenario[key], /^[a-z0-9-]+\.json$/, 'Fixtures must be local JSON basenames.');
    paths[key] = join(fixtures, scenario[key]);
    hashes[key] = { file: `fixtures/engine-comparison/${scenario[key]}`, sha256: await sha256(paths[key]) };
  }
  const evidence = JSON.parse(await readFile(paths.evidence, 'utf8'));
  const analysis = analyzeRelease(await readFile(paths.baseline, 'utf8'), await readFile(paths.candidate, 'utf8'), { consumerEvidence: evidence });
  await json(join(directory, 'contractguard.json'), analysis);
  const oas = await run(options['--oasdiff'], ['breaking', paths.baseline, paths.candidate, '--format', 'json', '--fail-on', 'ERR', '--allow-external-refs=false', '--config', config]);
  await transcript(directory, 'oasdiff', oas);
  const openapiState = await run('java', ['-jar', options['--openapi-diff-jar'], paths.baseline, paths.candidate, '--state']);
  await transcript(directory, 'openapi-diff-state', openapiState);
  // In 2.1.7 --state returns before --fail-on-incompatible. Use a separate gate
  // invocation and retain both outputs rather than inferring compatibility from 0.
  const openapiGate = await run('java', ['-jar', options['--openapi-diff-jar'], paths.baseline, paths.candidate, '--fail-on-incompatible']);
  await transcript(directory, 'openapi-diff-gate', openapiGate);
  const item = { id: scenario.id, description: scenario.description, inputs: hashes, expected: scenario.expected,
    contractguard: { staticBreaking: analysis.summary.breaking > 0, staticSummary: analysis.summary, coverage: analysis.coverage?.status, consumerGate: analysis.consumerImpact?.gate, consumerSummary: analysis.consumerImpact?.summary },
    oasdiff: { exitCode: oas.exitCode }, openapiDiff: { state: openapiState.stdout.trim(), stateExitCode: openapiState.exitCode, gateExitCode: openapiGate.exitCode }, passed: false };
  result.cases.push(item);
  try {
    const findings = JSON.parse(oas.stdout);
    assert.ok(Array.isArray(findings), 'Expected oasdiff JSON array.');
    item.oasdiff.findings = findings;
    item.oasdiff.staticBreaking = findings.some((finding) => finding.level >= 3);
    const expected = scenario.expected;
    assert.equal(item.contractguard.staticBreaking, expected.staticBreaking, 'ContractGuard static expectation');
    assert.equal(item.contractguard.coverage, 'complete', 'Fixture should be in the implemented static profile');
    assert.equal(item.contractguard.consumerGate, expected.consumerGate, 'Consumer gate expectation');
    for (const key of ['regressions', 'passed', 'inconclusive', 'invalidBaselines']) assert.equal(item.contractguard.consumerSummary[key], expected[key], `Consumer ${key} expectation`);
    assert.equal(item.oasdiff.staticBreaking, expected.staticBreaking, 'oasdiff static expectation');
    assert.equal(oas.exitCode, expected.staticBreaking ? 1 : 0, 'oasdiff gate exit');
    assert.equal(openapiState.exitCode, 0, 'OpenAPI-diff state command exit');
    assert.equal(item.openapiDiff.state, expected.staticBreaking ? 'incompatible' : 'no_changes', 'OpenAPI-diff state expectation');
    assert.equal(openapiGate.exitCode, expected.staticBreaking ? 1 : 0, 'OpenAPI-diff gate exit');
    item.passed = true;
  } catch (error) {
    item.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  await json(join(output, 'results.json'), result);
  process.stdout.write(`${item.passed ? 'PASS' : 'FAIL'} ${item.id}: static=${item.contractguard.staticBreaking ? 'breaking' : 'unchanged'}, consumer=${item.contractguard.consumerGate}\n`);
}
result.completedAt = new Date().toISOString();
result.passed = result.cases.every((item) => item.passed);
await json(join(output, 'results.json'), result);
const table = result.cases.map((item) => `| ${item.id} | ${item.contractguard.staticBreaking ? 'breaking' : 'unchanged'} | ${item.oasdiff.staticBreaking ? 'breaking' : 'unchanged'} | ${item.openapiDiff.state} | ${item.contractguard.consumerGate} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
await writeFile(join(output, 'README.md'), `# Consumer evidence scope comparison\n\nGenerated: ${result.completedAt}\n\n${result.note}\n\nVersions: ContractGuard ${ENGINE_VERSION}; ${oasVersion.stdout.trim()}; ${openapiVersion.stdout.trim()}.\n\n| Case | ContractGuard static | oasdiff static | OpenAPI-diff static | ContractGuard consumer gate | Expectations |\n| --- | --- | --- | --- | --- | --- |\n${table}\n\nEach case directory retains the full ContractGuard JSON result, official-tool command arguments, exit codes, and unmodified stdout/stderr. The root results.json records input and binary SHA-256 values. This comparison makes no claim about real-world accuracy, rule breadth, runtime coverage, or speed.\n`);
