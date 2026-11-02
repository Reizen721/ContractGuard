import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getOasdiffExecutable, PINNED_OASDIFF_VERSION } from '../packages/oasdiff/dist/index.js';

// This verifies transparent delegation, not independently reimplemented rule accuracy.
const root = resolve(import.meta.dirname, '..');
const executable = await getOasdiffExecutable();
const cli = join(root, 'apps/cli/dist/index.js');
const directory = await mkdtemp(join(tmpdir(), 'contractguard-oasdiff-parity-'));
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--output')) throw new Error('Usage: node scripts/oasdiff-parity.mjs [--output results.json]');
const cases = [];
const baseline = { openapi: '3.0.4', info: { title: 'Parity fixture', version: '1' }, paths: {
  '/orders': { get: { operationId: 'getOrders', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } }],
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } },
} };
const candidate = structuredClone(baseline);
candidate.paths['/orders'].get.parameters[0].required = true;
candidate.paths['/orders'].get.parameters[0].schema.minimum = 2;
const base = join(directory, 'base.json');
const next = join(directory, 'next.json');
const env = { ...process.env, NO_COLOR: '1', OASDIFF_CONFIG: '' };
for (const key of Object.keys(env)) if (key.startsWith('OASDIFF_')) delete env[key];
function execute(command, args, input, cwd = directory) {
  return new Promise((done, reject) => {
    const process = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let size = 0;
    const timeout = setTimeout(() => { process.kill(); reject(new Error('Command timed out: ' + args.join(' '))); }, 30_000);
    process.on('error', (error) => { clearTimeout(timeout); reject(error); });
    for (const stream of ['stdout', 'stderr']) process[stream].on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { process.kill(); clearTimeout(timeout); reject(new Error('Output exceeds test budget')); }
      else chunks[stream].push(chunk);
    });
    process.on('close', (code, signal) => {
      clearTimeout(timeout);
      done({ code, signal, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() });
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}
async function parity(id, args, expected = 0, input) {
  const direct = await execute(executable, args, input);
  const delegated = await execute(process.execPath, [cli, 'oasdiff', ...args], input);
  assert.equal(direct.code, expected, id + ': upstream command failed: ' + direct.stderr);
  assert.deepEqual(delegated, direct, id + ': delegated stdout/stderr/exit differs');
  cases.push({ id, args, exitCode: direct.code, stdoutBytes: Buffer.byteLength(direct.stdout),
    stdoutSha256: createHash('sha256').update(direct.stdout).digest('hex'), passed: true });
  return direct;
}
let server;
try {
  await writeFile(base, JSON.stringify(baseline));
  await writeFile(next, JSON.stringify(candidate));
  await parity('version', ['--version']);
  for (const command of [[], ['breaking'], ['changelog'], ['diff'], ['summary'], ['validate'], ['upgrade'], ['flatten'],
    ['breaking-files'], ['git-diff-driver'], ['checks'], ['checks', 'changelog'], ['checks', 'changelog', 'coverage'], ['checks', 'validate'], ['schema'], ['completion']]) {
    await parity('help-' + (command.join('-') || 'root'), [...command, '--help']);
  }
  const checks = await parity('check-catalog', ['checks', 'changelog', '-f', 'json']);
  const validation = await parity('validation-catalog', ['checks', 'validate', '-f', 'json']);
  assert.equal(JSON.parse(checks.stdout).length, 778);
  assert.equal(JSON.parse(validation.stdout).length, 121);
  await parity('output-schema', ['schema']);
  await parity('coverage-catalog', ['checks', 'changelog', 'coverage', '-f', 'json', '--location', 'parameters']);
  await parity('bash-completion', ['completion', 'bash']);
  for (const format of ['json', 'yaml', 'text', 'markup', 'markdown', 'singleline', 'html', 'githubactions', 'junit']) {
    await parity('breaking-format-' + format, ['breaking', base, next, '-f', format]);
  }
  for (const command of ['changelog', 'diff', 'summary']) {
    await parity(command + '-json', [command, base, next, '-f', 'json']);
  }
  await parity('validate-valid', ['validate', base, '-f', 'json']);
  await parity('flatten-json', ['flatten', base, '-f', 'json']);
  await parity('upgrade-yaml', ['upgrade', base, '-f', 'yaml']);
  await parity('fail-on-error', ['breaking', base, next, '-f', 'json', '--fail-on', 'ERR'], 1);
  await parity('path-filter', ['breaking', base, next, '-f', 'json', '--match-path', '^/not-present']);
  await parity('localized-text', ['breaking', base, next, '--lang', 'es']);
  await parity('prefix-normalization', ['diff', base, next, '-f', 'json', '--prefix-base', '/v1', '--prefix-revision', '/v1']);
  await parity('stdin', ['diff', '-', next, '-f', 'json'], 0, JSON.stringify(baseline));
  await writeFile(join(directory, 'severity.yaml'), 'request-parameter-became-required warn\n');
  await parity('severity-config', ['breaking', base, next, '-f', 'json', '--severity-levels', join(directory, 'severity.yaml')]);
  await writeFile(join(directory, '.oasdiff.yaml'), 'lang: es\nformat: json\n');
  await parity('ambient-config', ['breaking', base, next]);
  await rm(join(directory, '.oasdiff.yaml'));
  await mkdir(join(directory, 'refs'));
  await writeFile(join(directory, 'refs', 'order.yaml'), 'type: object\nproperties:\n  id:\n    type: string\n');
  const referenced = structuredClone(baseline);
  referenced.paths['/orders'].get.responses[200].content['application/json'].schema = { $ref: './refs/order.yaml' };
  await writeFile(join(directory, 'referenced.json'), JSON.stringify(referenced));
  await parity('local-ref-flatten', ['flatten', join(directory, 'referenced.json'), '-f', 'json']);
  await parity('composed-globs', ['diff', join(directory, 'base*.json'), join(directory, 'next*.json'), '--composed', '-f', 'json']);
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/base' ? baseline : candidate));
  }).listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const url = 'http://127.0.0.1:' + server.address().port;
  await parity('url-inputs-loopback', ['breaking', url + '/base', url + '/next', '-f', 'json']);
  const git = async (...args) => {
    const result = await execute('git', args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git('init', '--quiet');
  await git('config', 'user.name', 'ContractGuard parity fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('add', 'base.json');
  await git('-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'baseline fixture');
  const oldBlob = await git('rev-parse', 'HEAD:base.json');
  await writeFile(base, JSON.stringify(candidate));
  await git('add', 'base.json');
  await git('-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'candidate fixture');
  const newBlob = await git('rev-parse', 'HEAD:base.json');
  await parity('git-revisions', ['breaking', 'HEAD~1:base.json', 'HEAD:base.json', '-f', 'json']);
  await parity('breaking-files', ['breaking-files', 'base.json', '--base', 'HEAD~1', '-f', 'json']);
  await parity('git-diff-driver', ['git-diff-driver', 'base.json', 'old', oldBlob, '100644', 'new', newBlob, '100644']);
  // Deliberately exercise a usage error: preserve upstream's exit and stderr too.
  const invalid = await execute(executable, ['diff', '--not-a-real-option']);
  await parity('upstream-usage-error', ['diff', '--not-a-real-option'], invalid.code);
  if (argv[1]) {
    const output = resolve(argv[1]);
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, JSON.stringify({ version: PINNED_OASDIFF_VERSION, sourceCommit: 'a4ba100f880c7579765c5e63915a99bf1acc6967',
      catalogCounts: { changelog: 778, validate: 121 }, scope: 'CLI delegation parity; not an independent rule-accuracy benchmark', cases }, null, 2));
  }
  console.log('oasdiff ' + PINNED_OASDIFF_VERSION + ': ' + cases.length + ' delegation checks passed (stdout, stderr, exit).');
} finally {
  if (server) await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
