#!/usr/bin/env node
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  analyzeRelease,
  createRegressionPack,
  validateRegressionPack,
  ENGINE_VERSION,
  ruleCatalog,
  validateRulePolicy,
  type RulePolicy,
  type AnalysisResult,
} from '@contractguard/core';
import { Command, InvalidArgumentError } from 'commander';
import { formatResult, terminalSafe, type OutputFormat } from './formatters.js';
import { loadLocalContract } from './bundle-loader.js';
import { registerCallerCommand } from './caller-command.js';
import { registerProjectCommand } from './project-command.js';

type FailOn = 'breaking' | 'potentially-breaking' | 'never';
type ConsumerFailOn = 'regression' | 'review' | 'never';

const program = new Command()
  .name('contractguard')
  .description('Detect backward-incompatible changes between two OpenAPI 3.x contracts.')
  .version(ENGINE_VERSION)
  .showHelpAfterError();

program.command('compare')
  .description('Compare a baseline OpenAPI contract with a candidate contract.')
  .argument('<baseline>', 'baseline OpenAPI YAML or JSON file')
  .argument('<candidate>', 'candidate OpenAPI YAML or JSON file')
  .option('-f, --format <format>', 'table, json, markdown, or html', parseFormat, 'table')
  .option('-o, --output <file>', 'write the report to a file instead of stdout')
  .option('--fail-on <level>', 'breaking, potentially-breaking, or never', parseFailOn, 'breaking')
  .option('--policy <file>', 'apply a ContractGuard rule policy JSON file')
  .option('--bundle', 'load only referenced local files within each explicitly allowed root')
  .option('--baseline-root <directory>', 'allowed baseline root with --bundle (default: entry directory)')
  .option('--candidate-root <directory>', 'allowed candidate root with --bundle (default: entry directory)')
  .option('--fail-on-incomplete', 'also fail with code 2 when coverage is partial; independent of --fail-on')
  .option('--consumer-evidence <file>', 'local JSON consumer examples and consumer-owned response assertions (max 1 MiB)')
  .option('--fail-on-consumer <level>', 'independent consumer gate: regression, review, or never', parseConsumerFailOn, 'regression')
  .option('--write-regression-pack <file>', 'create a new portable pack containing both contracts and original consumer examples')
  .action(async (
    baselinePath: string,
    candidatePath: string,
    options: { format: OutputFormat; output?: string; failOn: FailOn; policy?: string; bundle?: boolean; baselineRoot?: string; candidateRoot?: string; failOnIncomplete?: boolean; consumerEvidence?: string; failOnConsumer: ConsumerFailOn; writeRegressionPack?: string },
    command: Command,
  ) => {
    try {
      if (!options.bundle && (options.baselineRoot || options.candidateRoot)) throw new Error('Root options require --bundle.');
      if (!options.consumerEvidence && (options.writeRegressionPack || command.getOptionValueSource('failOnConsumer') === 'cli')) {
        throw new Error('Consumer gate options and regression packs require --consumer-evidence.');
      }
      if (options.writeRegressionPack && options.output && await sameFile(options.writeRegressionPack, options.output)) {
        throw new Error('The report and regression pack must have different output paths.');
      }
      if (options.output) {
        for (const input of [baselinePath, candidatePath, options.consumerEvidence, options.policy]) {
          if (input && await sameFile(input, options.output)) throw new Error('A report cannot overwrite an input file.');
        }
      }
      const [baseline, candidate] = options.bundle
        ? await Promise.all([loadLocalContract(baselinePath, options.baselineRoot), loadLocalContract(candidatePath, options.candidateRoot)])
        : await Promise.all([readFile(resolve(baselinePath), 'utf8'), readFile(resolve(candidatePath), 'utf8')]);
      const policy = options.policy === undefined ? undefined : await readPolicy(options.policy);
      const consumerEvidence = options.consumerEvidence === undefined ? undefined : await readJsonFile(options.consumerEvidence, 1024 * 1024);
      const result = analyzeRelease(baseline, candidate, { ...(policy === undefined ? {} : { policy }), ...(consumerEvidence === undefined ? {} : { consumerEvidence }) });
      if (options.writeRegressionPack) {
        const packPath = resolve(options.writeRegressionPack);
        await mkdir(dirname(packPath), { recursive: true });
        // Compact JSON keeps the exported byte size within the validator's canonical 16 MiB budget.
        await writeFile(packPath, JSON.stringify(createRegressionPack(baseline, candidate, consumerEvidence, policy)), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        process.stderr.write(`Regression pack created: ${terminalSafe(packPath)}. It contains original examples; review before sharing.\n`);
      }
      const rendered = formatResult(result, options.format, {
        baseline: basename(baselinePath),
        candidate: basename(candidatePath),
      });
      if (options.output) {
        const outputPath = resolve(options.output);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, rendered, 'utf8');
        process.stderr.write(`Report written to ${terminalSafe(outputPath)}\n`);
      } else {
        process.stdout.write(rendered);
      }
      if (thresholdReached(result.summary, options.failOn)
        || (options.failOnIncomplete && result.coverage?.status === 'partial')
        || consumerThresholdReached(result, options.failOnConsumer)) process.exitCode = 2;
    } catch (error) {
      process.stderr.write(`ContractGuard error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    }
  });

program.command('verify-pack')
  .description('Replay an explicitly created regression pack offline using a compatible engine and its recorded policy.')
  .argument('<file>', 'portable ContractGuard regression JSON pack')
  .option('-f, --format <format>', 'table, json, markdown, or html', parseFormat, 'table')
  .option('-o, --output <file>', 'write the report to a file instead of stdout')
  .option('--fail-on <level>', 'breaking, potentially-breaking, or never', parseFailOn, 'breaking')
  .option('--fail-on-consumer <level>', 'regression, review, or never', parseConsumerFailOn, 'review')
  .option('--fail-on-incomplete', 'fail when static coverage is partial')
  .action(async (file: string, options: { format: OutputFormat; output?: string; failOn: FailOn; failOnConsumer: ConsumerFailOn; failOnIncomplete?: boolean }) => {
    try {
      if (options.output && await sameFile(file, options.output)) throw new Error('A report cannot overwrite its regression pack.');
      const pack = validateRegressionPack(await readJsonFile(file, 16 * 1024 * 1024));
      if (pack.engineVersion !== ENGINE_VERSION) {
        process.stderr.write(`Replaying compatible legacy pack (${pack.engineVersion}) with ContractGuard ${ENGINE_VERSION}; original pack and fingerprint are unchanged.\n`);
      }
      const result = analyzeRelease(pack.baseline, pack.candidate, {
        ...(pack.policy === undefined ? {} : { policy: pack.policy }), consumerEvidence: pack.consumerEvidence,
      });
      const rendered = formatResult(result, options.format, { baseline: 'pack baseline', candidate: 'pack candidate' });
      if (options.output) {
        const destination = resolve(options.output);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, rendered, 'utf8');
      } else process.stdout.write(rendered);
      if (thresholdReached(result.summary, options.failOn) || consumerThresholdReached(result, options.failOnConsumer)
        || (options.failOnIncomplete && result.coverage?.status === 'partial')) process.exitCode = 2;
    } catch (error) {
      process.stderr.write(`ContractGuard error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    }
  });

program.command('rules')
  .description('Print the built-in compatibility rule catalog.')
  .option('--json', 'print machine-readable JSON')
  .action((options: { json?: boolean }) => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(ruleCatalog, null, 2)}\n`);
      return;
    }
    for (const rule of ruleCatalog) process.stdout.write(`${rule.id.padEnd(34)} ${rule.defaultSeverity.padEnd(21)} ${rule.title}\n`);
  });

program.command('oasdiff [arguments...]')
  .description('Delegate all commands and options unchanged to the pinned official oasdiff CLI.');

program.command('agent')
  .description('Run bounded contract and consumer checks, then produce an evidence-linked migration review.')
  .argument('<baseline>', 'baseline OpenAPI YAML or JSON file')
  .argument('<candidate>', 'candidate OpenAPI YAML or JSON file')
  .option('--consumer-evidence <file>', 'explicit local consumer evidence JSON (max 1 MiB)')
  .option('--bundle', 'load referenced local files within each explicitly allowed root')
  .option('--baseline-root <directory>', 'allowed baseline root with --bundle')
  .option('--candidate-root <directory>', 'allowed candidate root with --bundle')
  .option('--mode <mode>', 'workflow (no model) or llm (server-configured model)', (value: string) => {
    if (value === 'workflow' || value === 'llm') return value;
    throw new InvalidArgumentError('mode must be workflow or llm');
  }, 'workflow')
  .option('--provider <id>', 'configured LLM profile ID; requires --mode llm')
  .option('--goal <text>', 'review objective; does not authorize commands or network access')
  .option('--data-dir <directory>', 'local task record directory (one process per directory)', 'data/agent-cli')
  .option('-f, --format <format>', 'json or markdown', (value: string) => {
    if (value === 'json' || value === 'markdown') return value;
    throw new InvalidArgumentError('agent format must be json or markdown');
  }, 'markdown')
  .option('-o, --output <file>', 'write the completed review to a file')
  .action(async (baselinePath: string, candidatePath: string, options: {
    consumerEvidence?: string; bundle?: boolean; baselineRoot?: string; candidateRoot?: string;
    mode: 'workflow' | 'llm'; provider?: string; goal?: string; dataDir: string;
    format: 'json' | 'markdown'; output?: string;
  }) => {
    const { AgentManager, formatAgentReportMarkdown } = await import('@contractguard/api/agent');
    let manager: InstanceType<typeof AgentManager> | undefined;
    let cancel: (() => void) | undefined;
    try {
      if (!options.bundle && (options.baselineRoot || options.candidateRoot)) throw new Error('Root options require --bundle.');
      if (options.provider && options.mode !== 'llm') throw new Error('--provider requires --mode llm.');
      if (options.output) {
        for (const input of [baselinePath, candidatePath, options.consumerEvidence]) {
          if (input && await sameFile(input, options.output)) throw new Error('A report cannot overwrite an input file.');
        }
      }
      const [baseline, candidate] = options.bundle
        ? await Promise.all([loadLocalContract(baselinePath, options.baselineRoot), loadLocalContract(candidatePath, options.candidateRoot)])
        : await Promise.all([readFile(resolve(baselinePath), 'utf8'), readFile(resolve(candidatePath), 'utf8')]);
      const consumerEvidence = options.consumerEvidence === undefined ? undefined : await readJsonFile(options.consumerEvidence, 1024 * 1024);
      manager = new AgentManager({ dataDirectory: resolve(options.dataDir) });
      const run = await manager.submit({
        baseline, candidate, baselineName: basename(baselinePath), candidateName: basename(candidatePath), mode: options.mode,
        ...(consumerEvidence === undefined ? {} : { consumerEvidence }),
        ...(options.provider === undefined ? {} : { providerId: options.provider }),
        ...(options.goal === undefined ? {} : { goal: options.goal }),
      });
      cancel = () => { void manager!.cancel(run.id); };
      process.once('SIGINT', cancel);
      const completed = await manager.wait(run.id);
      const rendered = options.format === 'json' ? `${JSON.stringify(completed, null, 2)}\n` : formatAgentReportMarkdown(completed);
      if (options.output) {
        const destination = resolve(options.output);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, rendered, 'utf8');
      } else process.stdout.write(rendered);
      process.exitCode = completed.status === 'cancelled' ? 130
        : completed.status !== 'completed' ? 1 : completed.verdict === 'pass' ? 0 : 2;
    } catch (error) {
      process.stderr.write(`ContractGuard agent error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    } finally {
      if (cancel) process.removeListener('SIGINT', cancel);
      await manager?.close();
    }
  });

registerCallerCommand(program);
registerProjectCommand(program);

// Do not let Commander consume, reorder, or reinterpret upstream options (including --help).
if (process.argv[2] === 'oasdiff') {
  try {
    const { runOasdiffPassthrough } = await import('@contractguard/oasdiff');
    process.exitCode = await runOasdiffPassthrough(process.argv.slice(3));
  } catch (error) {
    process.stderr.write(`ContractGuard oasdiff error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
} else await program.parseAsync(process.argv);

function parseFormat(value: string): OutputFormat {
  if (['table', 'json', 'markdown', 'html'].includes(value)) return value as OutputFormat;
  throw new InvalidArgumentError('format must be table, json, markdown, or html');
}

function parseFailOn(value: string): FailOn {
  if (['breaking', 'potentially-breaking', 'never'].includes(value)) return value as FailOn;
  throw new InvalidArgumentError('level must be breaking, potentially-breaking, or never');
}

function parseConsumerFailOn(value: string): ConsumerFailOn {
  if (value === 'regression' || value === 'review' || value === 'never') return value;
  throw new InvalidArgumentError('consumer level must be regression, review, or never');
}

function consumerThresholdReached(result: AnalysisResult, level: ConsumerFailOn): boolean {
  if (!result.consumerImpact || level === 'never') return false;
  return level === 'review' ? result.consumerImpact.gate !== 'pass' : result.consumerImpact.gate === 'blocked';
}

async function readJsonFile(file: string, limit: number): Promise<unknown> {
  const target = resolve(file);
  const stats = await stat(target);
  if (!stats.isFile() || stats.size > limit) throw new Error(`JSON input must be a regular file no larger than ${limit} bytes.`);
  const text = await readFile(target, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('JSON input exceeds the byte limit.');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON input is not valid JSON.'); }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const canonical = async (file: string): Promise<string> => {
    let path: string;
    try { path = await realpath(resolve(file)); } catch { path = resolve(file); }
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  if (await canonical(left) === await canonical(right)) return true;
  try {
    const [a, b] = await Promise.all([stat(resolve(left)), stat(resolve(right))]);
    return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

export function thresholdReached(summary: { breaking: number; potentiallyBreaking: number }, failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  if (failOn === 'potentially-breaking') return summary.breaking + summary.potentiallyBreaking > 0;
  return summary.breaking > 0;
}

async function readPolicy(path: string): Promise<RulePolicy> {
  const policyPath = resolve(path);
  const policyStats = await stat(policyPath);
  if (!policyStats.isFile()) throw new Error(`Rule policy is not a regular file: ${terminalSafe(policyPath)}`);
  if (policyStats.size > 64 * 1024) throw new Error('Rule policy exceeds the 65536-byte limit.');
  const contents = await readFile(policyPath, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > 64 * 1024) {
    throw new Error('Rule policy exceeds the 65536-byte limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Rule policy is not valid JSON: ${terminalSafe(policyPath)}`);
  }
  return validateRulePolicy(parsed);
}
