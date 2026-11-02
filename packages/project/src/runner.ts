import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { CallerPatch } from '@contractguard/caller';
import { ProjectError } from './errors.js';
import { PROJECT_LIMITS, projectPath, sha256, snapshots } from './registry.js';
import { parseNodeReport } from './node-reporter.js';
import type { PreparedProject, ProjectPhase, ProjectSnapshot, ProjectTestReport } from './types.js';

const require = createRequire(import.meta.url);
const counts = () => ({ passed: 0, failed: 0, skipped: 0, total: 0 });
const emptyPhase = (reason: string, cancelled = false): ProjectPhase => ({ status: cancelled ? 'cancelled' : 'inconclusive', exitCode: null, tests: counts(), durationMs: 0, output: '', truncated: false, reason });
function clean(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }
function environment(working: string): NodeJS.ProcessEnv {
  // Never inherit tokens, model credentials, NODE_OPTIONS, npm scripts or user HOME.
  const result: NodeJS.ProcessEnv = { HOME: working, USERPROFILE: working, TMP: working, TEMP: working, TMPDIR: working, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TZ: 'UTC', LANG: 'C.UTF-8' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) result[key] = process.env[key];
  result.PATH = dirname(process.execPath);
  return result;
}
function stopTree(pid: number): void {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } } }
}
function reportFile(file: string, workspace: string, allowed: string[]): string {
  const path = relative(workspace, file).replaceAll('\\', '/');
  if (!allowed.includes(path)) throw new Error('Runner executed a test outside the configured test file list.');
  return path;
}
function parseVitestReport(text: string, workspace: string, allowed: string[]): { tests: ProjectPhase['tests']; identity: string } {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Invalid Vitest JSON report.');
  const report = value as Record<string, unknown>;
  for (const name of ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']) if (!Number.isInteger(report[name]) || Number(report[name]) < 0) throw new Error('Vitest report has invalid test counts.');
  if (!Array.isArray(report.testResults)) throw new Error('Vitest report has no test results.');
  const result = { total: Number(report.numTotalTests), passed: Number(report.numPassedTests), failed: Number(report.numFailedTests), skipped: Number(report.numPendingTests) + Number(report.numTodoTests ?? 0) };
  if (result.total !== result.passed + result.failed + result.skipped) throw new Error('Vitest test counts disagree.');
  const files = new Set<string>(); const identities: string[][] = [];
  for (const item of report.testResults as Array<Record<string, unknown>>) {
    if (typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) throw new Error('Vitest file results are invalid.');
    const file = reportFile(item.name, workspace, allowed); files.add(file);
    for (const assertion of item.assertionResults as Array<Record<string, unknown>>) {
      if (typeof assertion.fullName !== 'string' || !assertion.fullName) throw new Error('Vitest test identity is missing.');
      identities.push([file, assertion.fullName, ['pending', 'todo', 'skipped', 'disabled'].includes(String(assertion.status)) ? 'skipped' : 'executed']);
    }
  }
  if (files.size !== allowed.length || allowed.some((file) => !files.has(file)) || identities.length !== result.total) throw new Error('Vitest test selection or count does not match the configured files.');
  return { tests: result, identity: sha256(JSON.stringify(identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))) };
}
async function writeSnapshot(workspace: string, snapshot: ProjectSnapshot, phase: 'baseline' | 'candidate', patches: Map<string, Buffer>): Promise<void> {
  for (const [file, content] of snapshot.files) {
    const target = join(workspace, ...file.split('/')); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, patches.get(file) ?? snapshot.overlays[phase].get(file) ?? content, { flag: 'wx' });
  }
}
async function phaseRun(base: string, label: string, snapshot: ProjectSnapshot, side: 'baseline' | 'candidate', patches: Map<string, Buffer>, signal?: AbortSignal): Promise<ProjectPhase> {
  if (signal?.aborted) return emptyPhase('Project tests were cancelled.', true);
  const workspace = join(base, label); await mkdir(workspace);
  await writeSnapshot(workspace, snapshot, side, patches);
  const reporter = join(base, `${label}.${snapshot.manifest.tests.runner === 'node-test' ? 'ndjson' : 'json'}`);
  const args: string[] = [];
  if (snapshot.dependencyDirectory) await symlink(snapshot.dependencyDirectory, join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  if (snapshot.manifest.tests.runner === 'node-test') {
    args.push('--experimental-strip-types', '--test', '--test-concurrency=1', `--test-reporter=${new URL('./node-reporter.js', import.meta.url).href}`, `--test-reporter-destination=${reporter}`, '--test-reporter=spec', '--test-reporter-destination=stdout', ...snapshot.manifest.tests.files);
  } else {
    const vitestEntry = require.resolve('vitest/vitest.mjs');
    if (!snapshot.dependencyDirectory) {
      await mkdir(join(workspace, 'node_modules'));
      await symlink(dirname(vitestEntry), join(workspace, 'node_modules', 'vitest'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    let config = snapshot.manifest.tests.config ? join(workspace, snapshot.manifest.tests.config) : join(base, `${label}.vitest.mjs`);
    if (!snapshot.manifest.tests.config) await writeFile(config, 'export default { test: { environment: "node", watch: false, fileParallelism: false, maxWorkers: 1, minWorkers: 1 } };\n', { flag: 'wx' });
    args.push(vitestEntry, 'run', '--root', workspace, '--config', config, '--reporter=json', `--outputFile=${reporter}`, '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', '--no-color', ...snapshot.manifest.tests.files);
  }
  const started = Date.now(); const buffers: Buffer[] = []; let bytes = 0; let truncated = false; let termination: 'timeout' | 'cancelled' | 'output-limit' | undefined;
  let exitCode: number | null = null; let spawnFailed = false;
  await new Promise<void>((done) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env: environment(workspace), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = (why: typeof termination) => { if (termination) return; termination = why; if (child.pid) stopTree(child.pid); };
    const aborted = () => terminate('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => terminate('timeout'), snapshot.manifest.tests.timeoutMs ?? PROJECT_LIMITS.timeoutMs);
    const retain = (chunk: Buffer) => { bytes += chunk.length; if (bytes <= PROJECT_LIMITS.outputBytes) buffers.push(chunk); else { truncated = true; terminate('output-limit'); } };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code) => { exitCode = code; clearTimeout(timer); signal?.removeEventListener('abort', aborted); done(); });
    if (signal?.aborted) aborted();
  });
  const phase: ProjectPhase = { status: 'inconclusive', exitCode, tests: counts(), durationMs: Date.now() - started, output: clean(Buffer.concat(buffers).toString('utf8')).replaceAll(workspace, '[project-snapshot]').replaceAll(base, '[test-run]'), truncated };
  if (termination || spawnFailed) { phase.status = termination === 'cancelled' ? 'cancelled' : 'inconclusive'; phase.reason = termination === 'timeout' ? 'Existing tests exceeded the configured timeout.' : termination === 'output-limit' ? 'Existing tests exceeded the output budget.' : termination === 'cancelled' ? 'Existing tests were cancelled.' : 'The configured test runner could not start.'; return phase; }
  try {
    const info = await lstat(reporter); if (!info.isFile() || info.isSymbolicLink() || info.size > PROJECT_LIMITS.reportBytes) throw new Error('Test reporter output is missing or oversized.');
    const output = await readFile(reporter, 'utf8'); if (Buffer.byteLength(output) > PROJECT_LIMITS.reportBytes) throw new Error('Test reporter output is oversized.');
    const parsed = snapshot.manifest.tests.runner === 'node-test' ? parseNodeReport(output, workspace, snapshot.manifest.tests.files) : parseVitestReport(output, workspace, snapshot.manifest.tests.files);
    phase.tests = parsed.tests; phase.testIdentityHash = parsed.identity;
    if (snapshot.manifest.tests.runner === 'vitest') {
      const report = JSON.parse(output) as { testResults?: Array<{ message?: string }> };
      const details = (report.testResults ?? []).map((item) => item.message ?? '').filter(Boolean).join('\n');
      phase.output += clean(details).slice(0, PROJECT_LIMITS.outputBytes - Buffer.byteLength(phase.output));
      phase.output = phase.output.replaceAll(workspace, '[project-snapshot]').replaceAll(workspace.replaceAll('\\', '/'), '[project-snapshot]').replaceAll(base, '[test-run]').replaceAll(base.replaceAll('\\', '/'), '[test-run]');
    }
    if (phase.tests.total === 0 || phase.tests.passed + phase.tests.failed === 0) { phase.reason = 'No non-skipped existing test was executed.'; return phase; }
    if (exitCode === 0 && phase.tests.failed === 0 && phase.tests.passed > 0) phase.status = 'passed';
    else if (exitCode !== 0 && phase.tests.failed > 0) phase.status = 'failed';
    else phase.reason = 'Runner exit code and test results do not establish a valid test outcome.';
  } catch { phase.reason = 'The runner did not produce a complete, valid structured test report.'; }
  return phase;
}
function verifiedPatches(prepared: PreparedProject, snapshot: ProjectSnapshot, proposed: CallerPatch[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  if (proposed.length > 20) throw new ProjectError(400, 'INVALID_PROJECT_PATCH', 'Too many candidate patches.');
  const allowed = new Set(snapshot.manifest.caller?.files ?? []);
  for (const patch of proposed) {
    const path = projectPath(patch.file); const original = snapshot.files.get(path);
    if (!original || !allowed.has(path) || snapshot.manifest.tests.files.includes(path) || path === snapshot.manifest.tests.config || result.has(path) || !Array.isArray(patch.edits) || patch.edits.length > 200 || sha256(original) !== patch.sourceSha256 || sha256(patch.patchedContent) !== patch.patchedSha256) throw new ProjectError(400, 'INVALID_PROJECT_PATCH', 'Candidate patch does not match the prepared source snapshot.');
    let contents = original.toString('utf8'); let end = -1;
    const ordered = [...patch.edits].sort((a, b) => a.start - b.start);
    for (const edit of ordered) { if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < end || edit.end < edit.start || edit.end > contents.length || typeof edit.before !== 'string' || typeof edit.after !== 'string' || contents.slice(edit.start, edit.end) !== edit.before) throw new ProjectError(400, 'INVALID_PROJECT_PATCH', 'Candidate edits fail source-position validation.'); end = edit.end; }
    for (const edit of ordered.reverse()) contents = contents.slice(0, edit.start) + edit.after + contents.slice(edit.end);
    if (contents !== patch.patchedContent || Buffer.byteLength(contents) > PROJECT_LIMITS.fileBytes) throw new ProjectError(400, 'INVALID_PROJECT_PATCH', 'Candidate content does not match its declared edits.');
    result.set(path, Buffer.from(contents));
  }
  return result;
}

export async function runProjectTests(prepared: PreparedProject, options: { patches?: CallerPatch[]; signal?: AbortSignal } = {}): Promise<ProjectTestReport> {
  const snapshot = snapshots.get(prepared);
  if (!snapshot) throw new ProjectError(400, 'INVALID_PROJECT_SNAPSHOT', 'Project execution requires a snapshot prepared by this registry instance.');
  const patches = verifiedPatches(prepared, snapshot, options.patches ?? []);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'contractguard-project-')));
  try {
    const baseline = await phaseRun(base, 'baseline', snapshot, 'baseline', new Map(), options.signal);
    const candidate = options.signal?.aborted ? emptyPhase('Project tests were cancelled.', true) : await phaseRun(base, 'candidate', snapshot, 'candidate', new Map(), options.signal);
    const patched = patches.size ? options.signal?.aborted ? emptyPhase('Project tests were cancelled.', true) : await phaseRun(base, 'patched', snapshot, 'candidate', patches, options.signal) : undefined;
    const identicalBaselineCandidate = baseline.testIdentityHash !== undefined && baseline.testIdentityHash === candidate.testIdentityHash;
    const status = baseline.status === 'failed' ? 'invalid-baseline' : baseline.status !== 'passed' || !['passed', 'failed'].includes(candidate.status) || !identicalBaselineCandidate ? 'inconclusive' : candidate.status === 'failed' ? 'regression' : 'pass';
    const sameTests = patched && identicalBaselineCandidate && patched.testIdentityHash === baseline.testIdentityHash;
    const patchStatus = !patched ? 'not-proposed' : status === 'regression' && patched.status === 'passed' && sameTests ? 'verified' : patched.status === 'failed' ? 'failed' : 'unverified';
    return { schemaVersion: 1, evidenceKind: 'project-test-execution', projectId: prepared.metadata.id, snapshotFingerprint: prepared.metadata.snapshotFingerprint, runner: snapshot.manifest.tests.runner, testFiles: [...snapshot.manifest.tests.files], baseline, candidate, ...(patched ? { patched } : {}), status, patchStatus, patchIds: (options.patches ?? []).map((patch) => patch.id), limitations: [
      'These are actual executions of the selected existing test files in separate temporary source copies, using explicitly configured JSON provider fixtures. They are not the entire application suite unless the operator selected it.',
      'Only locally registered trusted projects are eligible. A normal subprocess is not an operating-system sandbox: trusted test code can access other local resources or make network requests. ContractGuard does not install dependencies or intentionally contact a business service.',
      'Configured test source and declared expected-output files are copied unchanged across phases; candidate patches only target declared caller sources. Operators must ensure JSON overlays represent provider responses, not an undeclared test oracle. A passing subset is not proof of production compatibility or coverage of all modified code.',
      'Model and API credentials are omitted from the child environment. Test output can still contain project data and is retained locally; inspect before sharing.',
      ...(snapshot.dependencyDirectory ? ['The configured existing dependency directory is shared with test copies. Trusted tests must not modify dependencies; this is not write isolation.'] : []),
    ] };
  } finally {
    const resolved = await realpath(base).catch(() => resolve(base)); const parent = await realpath(tmpdir()); const rel = relative(parent, resolved);
    if (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..' && rel.startsWith('contractguard-project-') && !rel.includes(sep)) await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
