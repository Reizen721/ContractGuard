import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprintObject } from '@contractguard/core';
import { validateCallerInput } from '@contractguard/caller';
import type { PreparedProject, ProjectManifest, ProjectSnapshot, ProjectSummary } from './types.js';
import { ProjectError, invalid } from './errors.js';

export const PROJECT_LIMITS = Object.freeze({ files: 2000, bytes: 16 * 1024 * 1024, fileBytes: 5 * 1024 * 1024, configBytes: 1024 * 1024, timeoutMs: 30_000, outputBytes: 64 * 1024, reportBytes: 1024 * 1024 });
export const snapshots = new WeakMap<PreparedProject, ProjectSnapshot>();
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function keys(value: unknown, allowed: string[], name: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${name} contains unsupported fields.`);
}
export function projectPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 300 || value.includes('\\') || isAbsolute(value) || /[\x00-\x1f\x7f:]/.test(value)) invalid('Project file paths must be bounded forward-slash relative paths.');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment) || /[<>"|?*]/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) invalid('Project file path contains a traversal or ambiguous segment.');
  return value;
}
function paths(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) invalid(`${name} must be a nonempty bounded path array.`);
  const result = value.map(projectPath);
  if (new Set(result.map((path) => path.toLowerCase())).size !== result.length) invalid(`${name} contains duplicate paths.`);
  return result;
}
function manifest(value: unknown): ProjectManifest {
  keys(value, ['id', 'label', 'root', 'include', 'baseline', 'candidate', 'caller', 'tests'], 'Project');
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.id)) invalid('Project id is invalid.');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160 || /[\x00-\x1f]/.test(value.label)) invalid('Project label is invalid.');
  if (typeof value.root !== 'string' || !value.root.trim() || value.root.length > 1000 || /[\x00-\x1f]/.test(value.root)) invalid('Project root is invalid.');
  value.include = paths(value.include, 'include', 100);
  projectPath(value.baseline); projectPath(value.candidate);
  keys(value.tests, ['trusted', 'runner', 'files', 'timeoutMs', 'baseline', 'candidate', 'dependencyDirectory', 'config'], 'tests');
  if (value.tests.trusted !== true) invalid('Project tests must explicitly be marked trusted:true in the local registry.');
  if (!['node-test', 'vitest'].includes(String(value.tests.runner))) invalid('Supported test runners are node-test and vitest.');
  value.tests.files = paths(value.tests.files, 'tests.files', 100);
  if (value.tests.timeoutMs !== undefined && (!Number.isInteger(value.tests.timeoutMs) || Number(value.tests.timeoutMs) < 100 || Number(value.tests.timeoutMs) > 60_000)) invalid('Test timeout must be 100–60000 ms.');
  if (value.tests.dependencyDirectory !== undefined) projectPath(value.tests.dependencyDirectory);
  if (value.tests.config !== undefined) { projectPath(value.tests.config); if (value.tests.runner !== 'vitest') invalid('Only Vitest accepts a configured test config.'); }
  for (const side of ['baseline', 'candidate']) if (value.tests[side] !== undefined) {
    const entries = value.tests[side]; if (!Array.isArray(entries) || entries.length > 50) invalid('Fixture overlays must be a bounded array.');
    const targets = new Set<string>();
    for (const entry of entries) {
      keys(entry, ['target', 'source'], 'Fixture overlay');
      const target = projectPath(entry.target); const source = projectPath(entry.source);
      if (!target.endsWith('.json') || !source.endsWith('.json')) invalid('Only JSON provider-response fixtures can be overlaid.');
      if (targets.has(target.toLowerCase())) invalid('Duplicate fixture overlay target.'); targets.add(target.toLowerCase());
    }
  }
  if (value.caller !== undefined) {
    keys(value.caller, ['files', 'scenarios', 'fixtureScenarios', 'fieldRenames'], 'caller');
    value.caller.files = paths(value.caller.files, 'caller.files', 20);
    for (const key of ['scenarios', 'fieldRenames']) if (value.caller[key] !== undefined) projectPath(value.caller[key]);
    if (value.caller.scenarios !== undefined && value.caller.fixtureScenarios !== undefined) invalid('Use scenarios or fixtureScenarios, not both.');
    if (value.caller.fixtureScenarios !== undefined && (!Array.isArray(value.caller.fixtureScenarios) || value.caller.fixtureScenarios.length > 30)) invalid('fixtureScenarios must be a bounded array.');
  }
  return value as unknown as ProjectManifest;
}
const excluded = (segment: string) => ['node_modules', '.git', '.tools', '.env'].includes(segment.toLowerCase()) || segment.toLowerCase().startsWith('.env.');
export async function checkedPath(root: string, file: string, directory = false): Promise<string> {
  projectPath(file);
  let current = root;
  for (const segment of file.split('/')) {
    current = join(current, segment);
    const entry = await lstat(current).catch(() => { throw new ProjectError(400, 'PROJECT_FILE_MISSING', 'A configured project file or directory is missing.'); });
    if (entry.isSymbolicLink()) invalid('Symbolic links and directory junctions are not accepted in project snapshots.');
  }
  const resolved = await realpath(current); const rel = relative(root, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) invalid('Project path escaped its configured root.');
  const info = await lstat(current);
  if (directory ? !info.isDirectory() : !info.isFile()) invalid('Configured project path has the wrong file type.');
  return resolved;
}
async function boundedRead(root: string, file: string): Promise<Buffer> {
  const checked = await checkedPath(root, file);
  if ((await lstat(checked)).size > PROJECT_LIMITS.fileBytes) invalid('Project file exceeds its size limit.');
  const value = await readFile(checked);
  if (value.length > PROJECT_LIMITS.fileBytes) invalid('Project file exceeds its size limit.');
  return value;
}
function parseJSON(bytes: Buffer, name: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return invalid(`${name} must be valid JSON.`); }
}

export class ProjectRegistry {
  constructor(private readonly configPath?: string) {}
  private async entries(): Promise<ProjectManifest[]> {
    if (!this.configPath) return [];
    let data: Buffer;
    try { if ((await lstat(this.configPath)).size > PROJECT_LIMITS.configBytes) invalid('Project registry exceeds its size limit.'); data = await readFile(this.configPath); }
    catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError(503, 'PROJECT_REGISTRY_UNAVAILABLE', 'Configured project registry cannot be read.'); }
    if (data.length > PROJECT_LIMITS.configBytes) invalid('Project registry exceeds its size limit.');
    const parsed = parseJSON(data, 'Project registry'); keys(parsed, ['schemaVersion', 'projects'], 'Registry');
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length > 30) invalid('Registry requires schemaVersion:1 and at most 30 projects.');
    const entries = parsed.projects.map(manifest);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) invalid('Duplicate registered project id.');
    return entries;
  }
  async list(): Promise<ProjectSummary[]> { return (await this.entries()).map(({ id, label, tests }) => ({ id, label, testsEnabled: true, runner: tests.runner })); }
  async prepare(id: string): Promise<PreparedProject> {
    const entry = (await this.entries()).find((item) => item.id === id);
    if (!entry) throw new ProjectError(404, 'PROJECT_NOT_FOUND', 'Project is not registered on this server.');
    const unresolvedRoot = resolve(dirname(resolve(this.configPath!)), entry.root);
    const rootInfo = await lstat(unresolvedRoot).catch(() => { throw new ProjectError(400, 'PROJECT_ROOT_MISSING', 'Configured project root is unavailable.'); });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) invalid('Project root must be an ordinary directory.');
    const root = await realpath(unresolvedRoot); const files = new Map<string, Buffer>(); let bytes = 0;
    const put = (path: string, value: Buffer) => {
      const collision = [...files.keys()].find((key) => key.toLowerCase() === path.toLowerCase() && key !== path);
      if (collision) invalid('Project has case-ambiguous file names.');
      if (files.has(path)) return;
      bytes += value.length;
      if (bytes > PROJECT_LIMITS.bytes || files.size >= PROJECT_LIMITS.files) invalid('Project snapshot exceeds its file count or byte limit.');
      files.set(path, value);
    };
    const collect = async (path: string): Promise<void> => {
      if (path.split('/').some(excluded)) return;
      const absolute = join(root, ...projectPath(path).split('/')); const info = await lstat(absolute).catch(() => { throw new ProjectError(400, 'PROJECT_FILE_MISSING', 'A configured included path is missing.'); });
      if (info.isSymbolicLink()) invalid('Project snapshots reject symbolic links and junctions.');
      if (info.isDirectory()) { await checkedPath(root, path, true); for (const name of (await readdir(absolute)).sort()) await collect(`${path}/${name}`); }
      else if (info.isFile()) put(path, await boundedRead(root, path));
      else invalid('Project snapshots only accept ordinary files and directories.');
    };
    for (const include of entry.include) { if (include.split('/').some(excluded)) invalid('Sensitive or dependency directories cannot be included in snapshots.'); await collect(include); }
    const load = async (path: string): Promise<Buffer> => { const file = projectPath(path); if (!files.has(file)) put(file, await boundedRead(root, file)); return files.get(file)!; };
    const baseline = (await load(entry.baseline)).toString('utf8'); const candidate = (await load(entry.candidate)).toString('utf8');
    const protectedFiles = new Set([entry.baseline, entry.candidate, ...entry.tests.files]);
    for (const file of entry.tests.files) if (!files.has(file)) invalid('Every configured test must be included in the snapshot.');
    if (entry.tests.config) { if (!files.has(entry.tests.config)) invalid('Vitest config must be included in the snapshot.'); protectedFiles.add(entry.tests.config); }
    let caller: PreparedProject['caller'];
    if (entry.caller) {
      const source = [];
      for (const file of entry.caller.files) { source.push({ path: file, content: (await load(file)).toString('utf8') }); protectedFiles.add(file); }
      let scenarios: unknown = [];
      if (entry.caller.scenarios) { protectedFiles.add(entry.caller.scenarios); scenarios = parseJSON(await load(entry.caller.scenarios), 'Caller scenarios'); }
      if (entry.caller.fixtureScenarios) {
        scenarios = await Promise.all(entry.caller.fixtureScenarios.map(async (scenario) => {
          keys(scenario, ['id', 'file', 'exportName', 'args', 'operation', 'baselineResponse', 'candidateResponse', 'expectedFile'], 'Fixture scenario');
          keys(scenario.baselineResponse, ['status', 'bodyFile'], 'baselineResponse'); keys(scenario.candidateResponse, ['status', 'bodyFile'], 'candidateResponse');
          const baselineFile = projectPath(scenario.baselineResponse.bodyFile); const candidateFile = projectPath(scenario.candidateResponse.bodyFile); const expected = projectPath(scenario.expectedFile); protectedFiles.add(expected);
          return { id: scenario.id, file: scenario.file, exportName: scenario.exportName, args: scenario.args ?? [], operation: scenario.operation,
            baselineResponse: { status: scenario.baselineResponse.status, body: parseJSON(await load(baselineFile), 'Baseline response fixture') },
            candidateResponse: { status: scenario.candidateResponse.status, body: parseJSON(await load(candidateFile), 'Candidate response fixture') }, expected: parseJSON(await load(expected), 'Expected-output fixture') };
        }));
      }
      const fieldRenames = entry.caller.fieldRenames ? parseJSON(await load(entry.caller.fieldRenames), 'Field renames') : undefined;
      if (entry.caller.fieldRenames) protectedFiles.add(entry.caller.fieldRenames);
      caller = validateCallerInput({ schemaVersion: 1, baseline, candidate, files: source, scenarios, ...(fieldRenames === undefined ? {} : { fieldRenames }) });
    }
    const overlays = { baseline: new Map<string, Buffer>(), candidate: new Map<string, Buffer>() };
    for (const side of ['baseline', 'candidate'] as const) for (const overlay of entry.tests[side] ?? []) {
      if (!files.has(overlay.target)) invalid('A fixture overlay target must already exist in the snapshot.');
      if (protectedFiles.has(overlay.target) || /(?:^|\/)(?:package(?:-lock)?|tsconfig|.*(?:expected|expectation|oracle|snapshot).*)\.json$/i.test(overlay.target)) invalid('A fixture overlay cannot replace source, tests, configuration, or declared expected outputs.');
      const contents = await load(overlay.source); parseJSON(contents, 'Provider response overlay'); overlays[side].set(overlay.target, contents);
    }
    let dependencyDirectory: string | undefined;
    if (entry.tests.dependencyDirectory) dependencyDirectory = await checkedPath(root, entry.tests.dependencyDirectory, true);
    const sourceFiles = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, contents]) => ({ path, sha256: sha256(contents) }));
    const prepared: PreparedProject = { metadata: { id: entry.id, label: entry.label, runner: entry.tests.runner, testFiles: [...entry.tests.files], sourceFiles, snapshotFingerprint: fingerprintObject({ manifest: { ...entry, root: '(configured-local-root)' }, files: sourceFiles }) }, baseline, candidate, ...(caller ? { caller } : {}) };
    // Public metadata is independent of the immutable bytes used for execution.
    snapshots.set(prepared, { manifest: structuredClone(entry), files, root, protectedFiles, overlays, ...(dependencyDirectory ? { dependencyDirectory } : {}) });
    return prepared;
  }
}
