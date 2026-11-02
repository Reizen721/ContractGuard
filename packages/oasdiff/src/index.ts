import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareContract, type OpenApiInput } from '@contractguard/core';
import { parse as parseYaml } from 'yaml';

export const PINNED_OASDIFF_VERSION = '1.35.0';
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const INPUT_LIMIT = 5 * 1024 * 1024;
const EXPANDED_LIMIT = 20 * 1024 * 1024;

export type OasdiffErrorCode = 'ENGINE_UNAVAILABLE' | 'VERSION_MISMATCH' | 'INVALID_ARGUMENT' | 'INVALID_INPUT' | 'CANCELLED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'PROCESS_ERROR';
export class OasdiffError extends Error {
  constructor(public readonly code: OasdiffErrorCode, message: string) {
    super(message);
    this.name = 'OasdiffError';
  }
}
export interface OasdiffExecutableOptions { executablePath?: string; }
export interface OasdiffRunOptions extends OasdiffExecutableOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface OasdiffResult {
  version: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
export interface OasdiffStatus {
  available: boolean;
  pinnedVersion: string;
  version?: string;
  reason?: string;
}

/** Only server/operator configuration supplies executablePath; never accept it in a request body. */
export async function getOasdiffExecutable(options: OasdiffExecutableOptions = {}): Promise<string> {
  const configured = options.executablePath ?? process.env.CONTRACTGUARD_OASDIFF_PATH;
  const executable = configured
    ? (isAbsolute(configured) ? configured : resolve(configured))
    : join(repositoryRoot, '.tools', 'oasdiff', PINNED_OASDIFF_VERSION, process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
  try {
    if (!(await stat(executable)).isFile()) throw new Error('not a file');
  } catch {
    throw new OasdiffError('ENGINE_UNAVAILABLE', `oasdiff ${PINNED_OASDIFF_VERSION} is not installed. Run node scripts/install-oasdiff.mjs or set CONTRACTGUARD_OASDIFF_PATH to the pinned executable.`);
  }
  return executable;
}

function positiveLimit(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new OasdiffError('INVALID_ARGUMENT', `${name} must be an integer between 1 and ${ceiling}.`);
  return value;
}

async function capture(executable: string, argv: string[], options: OasdiffRunOptions, env = process.env): Promise<Omit<OasdiffResult, 'version'>> {
  if (argv.length > 2_000 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new OasdiffError('INVALID_ARGUMENT', 'Arguments must be strings without NUL characters.');
  if (options.signal?.aborted) throw new OasdiffError('CANCELLED', 'oasdiff execution was cancelled.');
  const timeout = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT, 10 * 60_000, 'timeoutMs');
  const limit = positiveLimit(options.maxOutputBytes, DEFAULT_OUTPUT_LIMIT, 64 * 1024 * 1024, 'maxOutputBytes');
  const started = performance.now();
  return new Promise((accept, reject) => {
    const child = spawn(executable, argv, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let failure: OasdiffError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: OasdiffError): void => {
      if (failure) return;
      failure = error;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const cancel = (): void => stop(new OasdiffError('CANCELLED', 'oasdiff execution was cancelled.'));
    const timer = setTimeout(() => stop(new OasdiffError('TIMEOUT', `oasdiff exceeded its ${timeout} ms execution limit.`)), timeout);
    timer.unref();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > limit) return stop(new OasdiffError('OUTPUT_LIMIT', `oasdiff exceeded its ${limit}-byte output limit.`));
      target.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', () => { failure ??= new OasdiffError('PROCESS_ERROR', 'Could not start the configured oasdiff executable.'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (failure) return reject(failure);
      if (code === null) return reject(new OasdiffError('PROCESS_ERROR', `oasdiff terminated unexpectedly (${signal ?? 'no exit code'}).`));
      accept({ args: [...argv], exitCode: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), durationMs: Math.round(performance.now() - started) });
    });
  });
}

async function verifyVersion(executable: string, signal?: AbortSignal): Promise<string> {
  const result = await capture(executable, ['--version'], { timeoutMs: 5_000, maxOutputBytes: 8192, ...(signal ? { signal } : {}) });
  const match = /^oasdiff version (\d+\.\d+\.\d+)\s*$/.exec(result.stdout.trim());
  if (result.exitCode !== 0 || match?.[1] !== PINNED_OASDIFF_VERSION) throw new OasdiffError('VERSION_MISMATCH', `Expected oasdiff ${PINNED_OASDIFF_VERSION}; configured executable reported ${match?.[1] ?? 'an unrecognized version'}.`);
  return match[1];
}

export async function getOasdiffStatus(options: OasdiffExecutableOptions = {}): Promise<OasdiffStatus> {
  try {
    const version = await verifyVersion(await getOasdiffExecutable(options));
    return { available: true, version, pinnedVersion: PINNED_OASDIFF_VERSION };
  } catch (error) {
    return { available: false, pinnedVersion: PINNED_OASDIFF_VERSION, reason: error instanceof Error ? error.message : 'oasdiff is unavailable.' };
  }
}

/** Trusted local integration. Arguments, cwd and environment retain upstream semantics. */
export async function runOasdiff(argv: string[], options: OasdiffRunOptions = {}): Promise<OasdiffResult> {
  const executable = await getOasdiffExecutable(options);
  const version = await verifyVersion(executable, options.signal);
  return { version, ...await capture(executable, argv, options) };
}

/** Full upstream CLI, including stdin, colors, Git and upstream exit codes. Not a server API. */
export async function runOasdiffPassthrough(argv: string[], options: Pick<OasdiffRunOptions, 'cwd' | 'signal' | 'executablePath'> = {}): Promise<number> {
  const executable = await getOasdiffExecutable(options);
  await verifyVersion(executable, options.signal);
  if (options.signal?.aborted) throw new OasdiffError('CANCELLED', 'oasdiff execution was cancelled.');
  return new Promise((accept, reject) => {
    const child = spawn(executable, argv, { cwd: options.cwd, shell: false, windowsHide: true, stdio: 'inherit' });
    const cancel = (): void => { child.kill(); };
    const interrupt = (): void => { child.kill('SIGINT'); };
    const terminate = (): void => { child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.on('error', () => reject(new OasdiffError('PROCESS_ERROR', 'Could not start the configured oasdiff executable.')));
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', cancel);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      if (options.signal?.aborted) return reject(new OasdiffError('CANCELLED', 'oasdiff execution was cancelled.'));
      accept(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}

export type PreparedOasdiffCommand = 'validate' | 'breaking' | 'changelog' | 'diff' | 'summary' | 'flatten' | 'upgrade';
export interface PreparedOasdiffOptions extends Omit<OasdiffRunOptions, 'cwd'> { side?: 'baseline' | 'candidate'; }
export interface PreparedOasdiffInputs { baseline: OpenApiInput; candidate: OpenApiInput; }

function serializableDocument(input: OpenApiInput): string {
  let value: unknown;
  try {
    if (input !== null && typeof input === 'object' && 'kind' in input && input.kind === 'bundle') value = prepareContract(input).document;
    else if (typeof input === 'string' || input instanceof Uint8Array) {
      const source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
      if (Buffer.byteLength(source) > INPUT_LIMIT) throw new Error('Submitted document exceeds 5 MiB.');
      value = parseYaml(source, { strict: true, prettyErrors: false, maxAliasCount: 100 });
    } else value = input;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Submitted contract must be a JSON/YAML object.');
    let values = 0;
    let expandedBytes = 0;
    const ancestors = new WeakSet<object>();
    const visit = (item: unknown, depth: number): void => {
      if (++values > 200_000 || depth > 128) throw new Error('Submitted contract exceeds its value/depth budget.');
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Contract contains a non-finite number.');
        expandedBytes += Buffer.byteLength(JSON.stringify(item));
      } else if (typeof item === 'object') {
        if (ancestors.has(item)) throw new Error('Contract contains a circular object or YAML alias.');
        ancestors.add(item);
        for (const [key, child] of Object.entries(item)) {
          expandedBytes += Buffer.byteLength(key) + 4;
          if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw new Error('Offline execution accepts only internal references. Supply local files as an explicit bundle; network and filesystem references are disabled.');
          visit(child, depth + 1);
        }
        ancestors.delete(item);
      } else throw new Error('Contract must contain JSON-compatible values.');
      if (expandedBytes > EXPANDED_LIMIT) throw new Error('Expanded contract exceeds 20 MiB.');
    };
    visit(value, 0);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > EXPANDED_LIMIT) throw new Error('Expanded contract exceeds 20 MiB.');
    return text;
  } catch (error) {
    // Never include supplied document fragments or upstream parser excerpts in errors/logs.
    if (error instanceof OasdiffError) throw error;
    const reason = error instanceof Error && !/parse|yaml|json/i.test(error.name) ? error.message : 'Contract could not be parsed.';
    throw new OasdiffError('INVALID_INPUT', `Cannot prepare the offline contract: ${reason.slice(0, 500)}`);
  }
}

/** Bounded, offline, explicit-content execution for Web/Agent. No arbitrary flags, URLs or paths. */
export async function runPreparedOasdiff(command: PreparedOasdiffCommand, inputs: PreparedOasdiffInputs, options: PreparedOasdiffOptions = {}): Promise<OasdiffResult> {
  const commands: readonly string[] = ['validate', 'breaking', 'changelog', 'diff', 'summary', 'flatten', 'upgrade'];
  if (!commands.includes(command)) throw new OasdiffError('INVALID_ARGUMENT', 'This command is not available to the offline agent.');
  if (options.side !== undefined && !['baseline', 'candidate'].includes(options.side)) throw new OasdiffError('INVALID_ARGUMENT', 'Unknown contract side.');
  if (options.signal?.aborted) throw new OasdiffError('CANCELLED', 'oasdiff execution was cancelled.');
  const single = ['validate', 'flatten', 'upgrade'].includes(command);
  const sides: Array<'baseline' | 'candidate'> = single ? [options.side ?? 'baseline'] : ['baseline', 'candidate'];
  const documents = sides.map((side) => ({ side, content: serializableDocument(inputs[side]) }));
  const executable = await getOasdiffExecutable(options);
  const version = await verifyVersion(executable, options.signal);
  const directory = await mkdtemp(join(tmpdir(), 'contractguard-oasdiff-'));
  try {
    for (const document of documents) await writeFile(join(directory, `${document.side}.json`), document.content, { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'config.yaml'), '{}\n', { flag: 'wx', mode: 0o600 });
    const args = [command, ...sides.map((side) => `${side}.json`), '--format', 'json', '--allow-external-refs=false', '--config', 'config.yaml'];
    if (!single) args.push('--auto-upgrade', '--exclude-extensions', 'x-contractguard-bundle-files');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('OASDIFF_')));
    const result = await capture(executable, args, { ...options, cwd: directory }, env);
    // Preserve useful per-side locations while removing private temporary absolute paths.
    const sanitize = (text: string): string => text.split(directory).join('.').split(directory.replace(/\\/g, '/')).join('.').split(JSON.stringify(directory).slice(1, -1)).join('.');
    return { version, ...result, stdout: sanitize(result.stdout), stderr: sanitize(result.stderr) };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
