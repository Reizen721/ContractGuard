import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ContractGuardError, prepareContract, type OpenApiBundleInput } from '@contractguard/core';

const MAX_FILES = 50;
const MAX_BYTES = 5 * 1024 * 1024;

/** Explicit CLI-only filesystem adapter. Core and HTTP never read local paths. */
export async function loadLocalContract(entryPath: string, allowedRoot?: string): Promise<OpenApiBundleInput> {
  const entry = resolve(entryPath);
  const root = resolve(allowedRoot ?? dirname(entry));
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(root);
    if (!(await stat(physicalRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('The allowed contract root must be a readable directory.');
  }
  const entryRelative = relative(root, entry);
  if (!withinRoot(entryRelative)) throw new Error('The entry must be inside its allowed contract root.');
  const bundle: OpenApiBundleInput = { kind: 'bundle', entry: entryRelative.split(sep).join('/'), files: [] };
  const seen = new Set<string>();
  let bytes = 0;
  let next = bundle.entry;
  while (true) {
    if (seen.has(next) || bundle.files.length >= MAX_FILES) throw new Error('Contract dependency discovery exceeded its file budget.');
    seen.add(next);
    const absolute = resolve(root, next);
    if (!withinRoot(relative(root, absolute))) throw new Error('Contract file escapes its allowed root.');
    let content: string;
    try {
      if ((await lstat(absolute)).isSymbolicLink()) throw new Error('symbolic link');
      const physical = await realpath(absolute);
      if (!withinRoot(relative(physicalRoot, physical))) throw new Error('symbolic-link escape');
      const info = await stat(physical);
      if (!info.isFile() || info.size > MAX_BYTES - bytes) throw new Error('not a bounded regular file');
      content = await readFile(physical, 'utf8');
    } catch {
      throw new Error(`Cannot read bounded local contract file: ${safeName(next)}. Check that it exists inside the root and is not a symbolic link.`);
    }
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_BYTES) throw new Error('Contract package exceeds the 5 MiB total-content limit.');
    bundle.files.push({ path: next, content });
    try {
      prepareContract(bundle);
      return bundle;
    } catch (error) {
      if (!(error instanceof ContractGuardError) || error.code !== 'INVALID_BUNDLE'
        || typeof error.details?.missingFile !== 'string') throw error;
      next = error.details.missingFile;
      if (!withinRoot(next) || /[\\\u0000-\u001f]/.test(next)) throw new Error('Invalid local contract dependency.');
    }
  }
}

function withinRoot(path: string): boolean {
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
    && !path.startsWith('../') && !/^[A-Za-z]:/.test(path);
}

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}
