import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  synthesizeDifferentialWitnesses,
  validateOutboundRequest,
  type ContractWitness,
  type OpenApiInput,
  type OperationWitnessSuite,
  type OutboundRequestCapture,
  type SchemaAlignmentReport,
} from '@contractguard/core';
import {
  typecheckVirtualFiles,
  type CallerFile,
  type CompilerDiagnostic,
  type TypecheckReport,
} from '@contractguard/caller';
import { parseNodeReport } from './node-reporter.js';

export type CounterexampleKind =
  | 'compiler-diagnostic'
  | 'request-contract-violation'
  | 'nominal-test-failure'
  | 'adversarial-witness-crash';

export interface VerificationCounterexample {
  id: string;
  kind: CounterexampleKind;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  witnessId?: string;
  targetPath?: string;
  operation?: { method: string; path: string };
  message: string;
}

export interface AdversarialProbeEntrypoint {
  file: string;
  exportName: string;
  args: unknown[];
}

export interface CegarSandboxInput {
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  callerFiles: CallerFile[];
  testFiles: CallerFile[];
  probes?: AdversarialProbeEntrypoint[];
  seedBaselineResponses?: Record<string, { status?: number; body: unknown }>;
  alignment?: SchemaAlignmentReport;
  witnessSuites?: OperationWitnessSuite[];
  enableAdversarialFuzzing?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxExecutionSummary {
  passed: boolean;
  exitCode: number | null;
  tests: { passed: number; failed: number; skipped: number; total: number };
  testIdentityHash?: string;
  durationMs: number;
  capturedRequests: OutboundRequestCapture[];
  output: string;
}

export interface AdversarialWitnessResult {
  witnessId: string;
  witnessKind: ContractWitness['kind'];
  targetPath?: string;
  passed: boolean;
  error?: string;
  location?: { file: string; line: number; column: number };
}

export interface CegarVerificationReport {
  verified: boolean;
  typecheck: TypecheckReport;
  baselineRun?: SandboxExecutionSummary;
  candidateRun?: SandboxExecutionSummary;
  requestViolations: Array<{ code: string; location: string; message: string; method: string; url: string }>;
  adversarialResults: AdversarialWitnessResult[];
  counterexamples: VerificationCounterexample[];
}

function sandboxEnv(workingDir: string, interceptConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: workingDir,
    USERPROFILE: workingDir,
    TMP: workingDir,
    TEMP: workingDir,
    TMPDIR: workingDir,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TZ: 'UTC',
    CONTRACTGUARD_INTERCEPT_CONFIG: interceptConfigPath,
    PATH: dirname(process.execPath),
  };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  }
}

function parseStackLocation(
  output: string,
  workspace: string,
  knownCallerPaths: Set<string>,
): { file: string; line: number; column: number } | undefined {
  const normWs = workspace.replace(/\\/g, '/');
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    // Match file:///C:/... , file:///tmp/... , C:\... , or /tmp/... :line:col
    const matches = [
      ...line.matchAll(
        /(file:\/\/\/[A-Za-z]:[^\s():]+|file:\/\/\/[^\s():]+|(?<![A-Za-z0-9_:/])[A-Za-z]:[\\/][^\s():]+|(?<![A-Za-z0-9_:/])\/[^\s():]+):(\d+):(\d+)/g,
      ),
    ];
    for (const m of matches) {
      let rawSpec = m[1]!;
      if (/^file:\/\/\/[A-Za-z]:/.test(rawSpec)) {
        rawSpec = rawSpec.slice(8);
      } else if (rawSpec.startsWith('file:///')) {
        rawSpec = rawSpec.slice(7);
      }
      const rawFile = decodeURIComponent(rawSpec).replace(/\\/g, '/');
      if (rawFile.startsWith(`${normWs}/`)) {
        const rel = rawFile.slice(normWs.length + 1);
        if (knownCallerPaths.has(rel)) {
          return {
            file: rel,
            line: Number.parseInt(m[2]!, 10),
            column: Number.parseInt(m[3]!, 10),
          };
        }
      }
    }
    // Also match relative paths like (src/orders.ts:4:18)
    for (const callerPath of knownCallerPaths) {
      const escaped = callerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const relMatch = line.match(new RegExp(`(${escaped}):(\\d+):(\\d+)`));
      if (relMatch) {
        return {
          file: relMatch[1]!,
          line: Number.parseInt(relMatch[2]!, 10),
          column: Number.parseInt(relMatch[3]!, 10),
        };
      }
    }
  }
  return undefined;
}

function extractConciseErrorMessage(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) =>
    /^(TypeError|ReferenceError|RangeError|SyntaxError|AssertionError|Error):/.test(l),
  );
  if (errLine) return errLine.slice(0, 320);
  const diagLine = lines.find((l) => l.includes('Expected values to be strictly') || l.includes('Cannot read propert') || l.includes('is not a function'));
  if (diagLine) return diagLine.slice(0, 320);
  return lines.slice(0, 4).join(' | ').slice(0, 320) || 'Sandbox test execution failed.';
}

async function runNodeTestSuite(
  baseDir: string,
  label: string,
  callerFiles: CallerFile[],
  testFiles: CallerFile[],
  routes: Array<{ method: string; path: string; status: number; body: unknown }>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SandboxExecutionSummary> {
  const workspace = join(baseDir, label);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8');

  for (const file of [...callerFiles, ...testFiles]) {
    const dest = join(workspace, ...file.path.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf8');
  }

  const captureFile = join(baseDir, `${label}-captures.ndjson`);
  await writeFile(captureFile, '', 'utf8');
  const interceptConfigPath = join(baseDir, `${label}-intercept.json`);
  await writeFile(
    interceptConfigPath,
    JSON.stringify({ routes, captureFile }, null, 2),
    'utf8',
  );
  const reporterFile = join(baseDir, `${label}-events.ndjson`);

  const interceptorHref = new URL('./http-interceptor.js', import.meta.url).href;
  const reporterHref = new URL('./node-reporter.js', import.meta.url).href;
  const testRelPaths = testFiles.map((t) => t.path);

  const args = [
    '--experimental-strip-types',
    '--no-warnings',
    `--import=${interceptorHref}`,
    '--test',
    '--test-concurrency=1',
    `--test-reporter=${reporterHref}`,
    `--test-reporter-destination=${reporterFile}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    ...testRelPaths,
  ];

  const started = Date.now();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exitCode: number | null = null;

  await new Promise<void>((done) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: sandboxEnv(workspace, interceptConfigPath),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killed = false;
    const stop = () => {
      if (killed) return;
      killed = true;
      if (child.pid) killProcessTree(child.pid);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 256 * 1024) chunks.push(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => {});
    child.on('close', (code) => {
      exitCode = code;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      done();
    });
  });

  const rawOutput = Buffer.concat(chunks).toString('utf8');
  let tests = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let testIdentityHash: string | undefined;

  try {
    const reportText = await readFile(reporterFile, 'utf8');
    const parsed = parseNodeReport(reportText, workspace, testRelPaths);
    tests = parsed.tests;
    testIdentityHash = parsed.identity;
  } catch {
    // Fallback if process crashed before reporter flushed
  }

  let capturedRequests: OutboundRequestCapture[] = [];
  try {
    const capText = await readFile(captureFile, 'utf8');
    capturedRequests = capText
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OutboundRequestCapture);
  } catch {
    capturedRequests = [];
  }

  const passed = exitCode === 0 && tests.total > 0 && tests.failed === 0 && tests.passed > 0;
  return {
    passed,
    exitCode,
    tests,
    ...(testIdentityHash ? { testIdentityHash } : {}),
    durationMs: Date.now() - started,
    capturedRequests,
    output: rawOutput,
  };
}

async function runAdversarialProbe(
  baseDir: string,
  label: string,
  callerFiles: CallerFile[],
  probes: AdversarialProbeEntrypoint[],
  routes: Array<{ method: string; path: string; status: number; body: unknown }>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ passed: boolean; error?: string; location?: { file: string; line: number; column: number } }> {
  const workspace = join(baseDir, label);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8');

  for (const file of callerFiles) {
    const dest = join(workspace, ...file.path.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf8');
  }

  // Generate an isolated property-based crash & well-formedness runner
  const runnerLines = [
    `const probes = ${JSON.stringify(probes)};`,
    `for (const probe of probes) {`,
    `  const mod = await import('./' + probe.file);`,
    `  const fn = mod[probe.exportName];`,
    `  if (typeof fn !== 'function') throw new Error('Missing exported entrypoint: ' + probe.exportName);`,
    `  const out = await fn(...(probe.args ?? []));`,
    `  if (typeof out === 'number' && Number.isNaN(out)) throw new TypeError('Adversarial witness produced NaN in ' + probe.exportName);`,
    `  if (typeof out === 'string' && (out.includes('undefined') || out.includes('NaN'))) {`,
    `    throw new TypeError('Adversarial witness leaked stringified undefined/NaN in ' + probe.exportName + ': ' + out);`,
    `  }`,
    `}`,
  ];
  const probeRunnerPath = join(workspace, '__cegar_probe__.mts');
  await writeFile(probeRunnerPath, runnerLines.join('\n') + '\n', 'utf8');

  const captureFile = join(baseDir, `${label}-captures.ndjson`);
  await writeFile(captureFile, '', 'utf8');
  const interceptConfigPath = join(baseDir, `${label}-intercept.json`);
  await writeFile(interceptConfigPath, JSON.stringify({ routes, captureFile }, null, 2), 'utf8');
  const interceptorHref = new URL('./http-interceptor.js', import.meta.url).href;

  const chunks: Buffer[] = [];
  let exitCode: number | null = null;
  await new Promise<void>((done) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', `--import=${interceptorHref}`, probeRunnerPath],
      {
        cwd: workspace,
        env: sandboxEnv(workspace, interceptConfigPath),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let killed = false;
    const stop = () => {
      if (killed) return;
      killed = true;
      if (child.pid) killProcessTree(child.pid);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {});
    child.on('close', (code) => {
      exitCode = code;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      done();
    });
  });

  if (exitCode === 0) return { passed: true };
  const output = Buffer.concat(chunks).toString('utf8');
  const knownSet = new Set(callerFiles.map((f) => f.path));
  const loc = parseStackLocation(output, workspace, knownSet);
  return {
    passed: false,
    error: extractConciseErrorMessage(output),
    ...(loc ? { location: loc } : {}),
  };
}

function inferDefaultProbes(callerFiles: CallerFile[]): AdversarialProbeEntrypoint[] {
  const probes: AdversarialProbeEntrypoint[] = [];
  for (const file of callerFiles) {
    const matches = [...file.content.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g)];
    for (const m of matches) {
      const name = m[1]!;
      const paramsRaw = m[2]!.trim();
      if (!paramsRaw) {
        probes.push({ file: file.path, exportName: name, args: [] });
      } else {
        const paramCount = paramsRaw.split(',').filter(Boolean).length;
        const defaultArgs = Array.from({ length: paramCount }, (_, i) => (i === 0 ? 'ORD-101' : 'default'));
        probes.push({ file: file.path, exportName: name, args: defaultArgs });
      }
    }
  }
  return probes;
}

export async function verifyCegarWorkspace(
  input: CegarSandboxInput,
  candidateFilesOverride?: CallerFile[],
): Promise<CegarVerificationReport> {
  const activeCallerFiles = candidateFilesOverride ?? input.callerFiles;
  const timeoutMs = input.timeoutMs ?? 15_000;
  let cexSeq = 1;
  const nextCexId = () => `CEX-${String(cexSeq++).padStart(4, '0')}`;
  const counterexamples: VerificationCounterexample[] = [];

  // Gate 1: TypeScript Compiler TypeChecker Gate
  const typecheck = typecheckVirtualFiles(activeCallerFiles);
  if (!typecheck.clean) {
    for (const diag of typecheck.diagnostics) {
      counterexamples.push({
        id: nextCexId(),
        kind: 'compiler-diagnostic',
        file: diag.file,
        line: diag.line,
        column: diag.column,
        code: `TS${diag.code}`,
        message: `TS${diag.code} at ${diag.file}:${diag.line}:${diag.column} — ${diag.message}`,
      });
    }
    return {
      verified: false,
      typecheck,
      requestViolations: [],
      adversarialResults: [],
      counterexamples,
    };
  }

  const suites =
    input.witnessSuites ??
    synthesizeDifferentialWitnesses(input.baseline, input.candidate, {
      ...(input.alignment ? { alignment: input.alignment } : {}),
      ...(input.seedBaselineResponses ? { seedBaselineResponses: input.seedBaselineResponses } : {}),
    });

  const baselineRoutes = suites.map((s) => ({
    method: s.operation.method,
    path: s.operation.path,
    status: s.baselineNominal.status,
    body: s.baselineNominal.body,
  }));

  const candidateRoutes = suites.map((s) => ({
    method: s.operation.method,
    path: s.operation.path,
    status: s.candidateNominal.status,
    body: s.candidateNominal.body,
  }));

  const baseDir = await realpath(await mkdtemp(join(tmpdir(), 'contractguard-cegar-')));
  const knownCallerSet = new Set(activeCallerFiles.map((f) => f.path));

  try {
    // Gate 2: Baseline Sanity Execution (always runs original input.callerFiles against baseline contract)
    const baselineRun = await runNodeTestSuite(
      baseDir,
      'baseline',
      input.callerFiles,
      input.testFiles,
      baselineRoutes,
      timeoutMs,
      input.signal,
    );

    // Gate 3: Candidate Nominal Execution (runs activeCallerFiles against candidate nominal witnesses)
    const candidateRun = await runNodeTestSuite(
      baseDir,
      'candidate',
      activeCallerFiles,
      input.testFiles,
      candidateRoutes,
      timeoutMs,
      input.signal,
    );

    const identicalSuite =
      baselineRun.testIdentityHash !== undefined &&
      baselineRun.testIdentityHash === candidateRun.testIdentityHash;

    if (!candidateRun.passed || !identicalSuite) {
      const loc = parseStackLocation(candidateRun.output, join(baseDir, 'candidate'), knownCallerSet);
      counterexamples.push({
        id: nextCexId(),
        kind: 'nominal-test-failure',
        ...(loc ? { file: loc.file, line: loc.line, column: loc.column } : {}),
        message: !identicalSuite
          ? 'Executed test identities did not match baseline test suite.'
          : extractConciseErrorMessage(candidateRun.output),
      });
    }

    // Outbound Request Contract Validation Gate
    const requestViolations: CegarVerificationReport['requestViolations'] = [];
    for (const captured of candidateRun.capturedRequests) {
      const check = validateOutboundRequest(input.candidate, captured);
      if (!check.valid) {
        for (const v of check.violations) {
          requestViolations.push({
            ...v,
            method: captured.method,
            url: captured.url,
          });
          counterexamples.push({
            id: nextCexId(),
            kind: 'request-contract-violation',
            code: v.code,
            ...(check.matchedOperation ? { operation: check.matchedOperation } : {}),
            targetPath: v.location,
            message: `${captured.method} ${captured.url}: ${v.message}`,
          });
        }
      }
    }

    // Gate 4: Adversarial Differential Witness Fuzzing Gate
    const adversarialResults: AdversarialWitnessResult[] = [];
    if (input.enableAdversarialFuzzing !== false) {
      const probes = input.probes ?? inferDefaultProbes(activeCallerFiles);
      const calledOps = new Set(
        candidateRun.capturedRequests.map((req) => {
          const check = validateOutboundRequest(input.candidate, req);
          return check.matchedOperation ? `${check.matchedOperation.method} ${check.matchedOperation.path}` : '';
        }),
      );

      let advIdx = 0;
      for (const suite of suites) {
        const opKey = `${suite.operation.method} ${suite.operation.path}`;
        if (calledOps.size > 0 && !calledOps.has(opKey)) continue;

        for (const advWitness of suite.adversarial) {
          advIdx++;
          const advRoutes = suites.map((s) =>
            s.operation.method === suite.operation.method && s.operation.path === suite.operation.path
              ? { method: s.operation.method, path: s.operation.path, status: advWitness.status, body: advWitness.body }
              : { method: s.operation.method, path: s.operation.path, status: s.candidateNominal.status, body: s.candidateNominal.body },
          );
          const probeRes = await runAdversarialProbe(
            baseDir,
            `adv-${advIdx}`,
            activeCallerFiles,
            probes,
            advRoutes,
            timeoutMs,
            input.signal,
          );
          adversarialResults.push({
            witnessId: advWitness.id,
            witnessKind: advWitness.kind,
            ...(advWitness.targetPath ? { targetPath: advWitness.targetPath } : {}),
            passed: probeRes.passed,
            ...(probeRes.error ? { error: probeRes.error } : {}),
            ...(probeRes.location ? { location: probeRes.location } : {}),
          });

          if (!probeRes.passed) {
            counterexamples.push({
              id: nextCexId(),
              kind: 'adversarial-witness-crash',
              witnessId: advWitness.id,
              ...(advWitness.targetPath ? { targetPath: advWitness.targetPath } : {}),
              operation: suite.operation,
              ...(probeRes.location
                ? { file: probeRes.location.file, line: probeRes.location.line, column: probeRes.location.column }
                : {}),
              message: `Witness ${advWitness.id} (${advWitness.description}) crashed caller: ${probeRes.error ?? 'runtime failure'}`,
            });
          }
        }
      }
    }

    const verified =
      typecheck.clean &&
      baselineRun.passed &&
      candidateRun.passed &&
      identicalSuite &&
      requestViolations.length === 0 &&
      adversarialResults.every((r) => r.passed) &&
      counterexamples.length === 0;

    return {
      verified,
      typecheck,
      baselineRun,
      candidateRun,
      requestViolations,
      adversarialResults,
      counterexamples,
    };
  } finally {
    const parent = await realpath(tmpdir());
    const resolved = await realpath(baseDir).catch(() => resolve(baseDir));
    const rel = relative(parent, resolved);
    if (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel.startsWith('contractguard-cegar-')) {
      await rm(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  }
}
