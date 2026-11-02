import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CallerFile, CallerImpactReport } from '@contractguard/caller';

const MAX_FILES = 20;
const MAX_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_DEPTH = 30;
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);

export interface CollectedCallerSources {
  root: string;
  files: CallerFile[];
  absolutePaths: string[];
}

/** This filesystem adapter is CLI-only. Neither the engine nor the MCP server follows source paths. */
export async function collectCallerSources(sourceRoot: string): Promise<CollectedCallerSources> {
  const root = resolve(sourceRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('The source root must be a regular directory, not a link.');
  const physicalRoot = await realpath(root);
  const files: CallerFile[] = [];
  const absolutePaths: string[] = [];
  let bytes = 0;
  let entriesVisited = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('Source tree exceeds the maximum directory depth. Select a smaller source root.');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (++entriesVisited > MAX_ENTRIES) throw new Error('Source tree exceeds the 2000-entry traversal budget. Select a smaller source root.');
      if (entry.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Source links are not followed: ${relative(root, absolute)}. Select a source root without links.`);
      const physical = await realpath(absolute);
      if (!inside(physicalRoot, physical)) throw new Error('Source entry resolves outside its allowed root.');
      if (info.isDirectory()) { await visit(absolute, depth + 1); continue; }
      if (!info.isFile() || !['.ts', '.tsx'].includes(extname(entry.name).toLowerCase()) || /\.d\.tsx?$/i.test(entry.name)) continue;
      if (files.length >= MAX_FILES) throw new Error('Source collection exceeds the 20-file limit. Select a smaller source root.');
      if (info.size > MAX_FILE_BYTES) throw new Error('A source file exceeds the 256 KiB per-file limit.');
      if (info.size > MAX_BYTES - bytes) throw new Error('Source collection exceeds the 1 MiB total-content limit.');
      const content = await readFile(physical, 'utf8');
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > MAX_FILE_BYTES) throw new Error('A source file exceeds the 256 KiB per-file limit.');
      bytes += contentBytes;
      if (bytes > MAX_BYTES) throw new Error('Source collection exceeds the 1 MiB total-content limit.');
      const path = relative(root, absolute).split(sep).join('/');
      if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('Source paths cannot contain control characters.');
      files.push({ path, content });
      absolutePaths.push(physical);
    }
  }

  await visit(root, 0);
  if (files.length === 0) throw new Error('No .ts or .tsx source files found in the selected root. Declaration files and hidden/build directories are excluded.');
  return { root: physicalRoot, files, absolutePaths };
}

export async function readBoundedCallerFile(file: string, limit: number): Promise<string> {
  const path = resolve(file);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > limit) throw new Error(`Input must be a regular, non-linked file no larger than ${limit} bytes.`);
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > limit) throw new Error('Input exceeds its byte limit.');
  return content.replace(/^\uFEFF/, '');
}

export async function readCallerJson(file: string): Promise<unknown> {
  const contents = await readBoundedCallerFile(file, MAX_BYTES);
  try { return JSON.parse(contents); } catch { throw new Error('Caller scenarios/mappings input must contain valid JSON.'); }
}

/** New files only: even aliases or hard links to input files cannot be overwritten. */
export async function writeNewCallerReport(file: string, content: string, sourceRoot: string): Promise<void> {
  const destination = await requireOutsideSource(file, sourceRoot);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

/** Export candidates for review. Never apply changes to the original source tree. */
export async function exportCallerPatches(directory: string, report: CallerImpactReport, sourceRoot: string): Promise<void> {
  const destination = await requireOutsideSource(directory, sourceRoot);
  const patchFiles = new Set<string>();
  for (const patch of report.patches) {
    validatePatchPath(patch.file);
    const identity = patch.file.toLowerCase();
    if (patchFiles.has(identity)) throw new Error('Duplicate candidate patch source path.');
    patchFiles.add(identity);
  }
  await mkdir(dirname(destination), { recursive: true });
  // A new directory is required, including when an existing directory is empty.
  await mkdir(destination);
  const manifest = {
    schemaVersion: 1,
    evidenceKind: report.evidenceKind,
    inputFingerprint: report.inputFingerprint,
    note: 'Candidate copies only. Original source files are unchanged. Verification is bounded TypeScript replay, not full application execution or production safety.',
    patches: report.patches.map((patch, index) => ({
      id: patch.id, file: patch.file, sourceSha256: patch.sourceSha256, patchedSha256: patch.patchedSha256,
      diffFile: `patches/${String(index + 1).padStart(3, '0')}.diff`,
      candidateFile: `sources/${patch.file}`, verification: patch.verification,
    })),
  };
  const write = async (path: string, content: string): Promise<void> => {
    const target = resolve(destination, path);
    if (!inside(destination, target)) throw new Error('Patch output escapes its new directory.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  };
  await write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await write('patches.json', `${JSON.stringify(report.patches, null, 2)}\n`);
  for (const [index, patch] of report.patches.entries()) {
    await write(`patches/${String(index + 1).padStart(3, '0')}.diff`, patch.unifiedDiff);
    await write(`sources/${patch.file}`, patch.patchedContent);
  }
}

async function requireOutsideSource(destination: string, sourceRoot: string): Promise<string> {
  const target = resolve(destination);
  const projected = await projectedRealpath(target);
  const physicalRoot = await realpath(resolve(sourceRoot));
  if (samePath(physicalRoot, projected) || inside(physicalRoot, projected)) throw new Error('Reports and patch exports must be outside the source root. Original source files are never overwritten.');
  return target;
}

async function projectedRealpath(file: string): Promise<string> {
  let current = resolve(file);
  const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...tail); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(relative(parent, current));
      current = parent;
    }
  }
}

function validatePatchPath(path: string): void {
  if (path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\u0000-\u001f\u007f:]/.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part))
    || !['.ts', '.tsx'].includes(extname(path).toLowerCase())) throw new Error('Invalid candidate patch source path.');
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
