import { dirname } from 'node:path';
import { analyzeCallerImpact, renderCallerReport } from '@contractguard/caller';
import { Command, InvalidArgumentError } from 'commander';
import { loadLocalContract } from './bundle-loader.js';
import { collectCallerSources, exportCallerPatches, readBoundedCallerFile, readCallerJson, writeNewCallerReport } from './caller-files.js';
import { terminalSafe } from './formatters.js';

interface CallerCommandOptions {
  sourceRoot: string; scenarios: string; renames?: string; format: 'json' | 'markdown';
  output?: string; writePatches?: string; failOn: 'regression' | 'review' | 'never';
  bundle?: boolean; baselineRoot?: string; candidateRoot?: string;
}

export function registerCallerCommand(program: Command): void {
  program.command('review-callers')
    .description('Locate TypeScript fetch/axios callers, replay explicit response examples, and verify candidate field-renaming patches without executing application code.')
    .argument('<baseline>', 'baseline OpenAPI JSON/YAML file')
    .argument('<candidate>', 'candidate OpenAPI JSON/YAML file')
    .requiredOption('--source-root <directory>', 'explicit TypeScript root; max 20 files / 1 MiB; no links')
    .requiredOption('--scenarios <file>', 'JSON array of response scenarios and explicit expected outputs')
    .option('--renames <file>', 'JSON array of explicit top-level response field rename mappings')
    .option('--bundle', 'load referenced local contract files within allowed roots')
    .option('--baseline-root <directory>', 'allowed baseline root with --bundle (default: entry directory)')
    .option('--candidate-root <directory>', 'allowed candidate root with --bundle (default: entry directory)')
    .option('-f, --format <format>', 'json or markdown', parseCallerFormat, 'markdown')
    .option('-o, --output <file>', 'create a new report file outside the source root; never overwrite existing files')
    .option('--write-patches <new-directory>', 'export candidate source copies, diffs and verification manifest to a new directory outside source root')
    .option('--fail-on <level>', 'regression (blocked), review (blocked or unknown), or never', parseCallerFailOn, 'review')
    .action(async (baselinePath: string, candidatePath: string, options: CallerCommandOptions) => {
      try {
        if (!options.bundle && (options.baselineRoot || options.candidateRoot)) throw new Error('Contract root options require --bundle.');
        const sources = await collectCallerSources(options.sourceRoot);
        const [baseline, candidate, scenarios, fieldRenames] = await Promise.all([
          options.bundle ? loadLocalContract(baselinePath, options.baselineRoot ?? dirname(baselinePath)) : readBoundedCallerFile(baselinePath, 5 * 1024 * 1024),
          options.bundle ? loadLocalContract(candidatePath, options.candidateRoot ?? dirname(candidatePath)) : readBoundedCallerFile(candidatePath, 5 * 1024 * 1024),
          readCallerJson(options.scenarios),
          options.renames === undefined ? Promise.resolve(undefined) : readCallerJson(options.renames),
        ]);
        if (!Array.isArray(scenarios)) throw new Error('--scenarios must contain a JSON array.');
        if (fieldRenames !== undefined && !Array.isArray(fieldRenames)) throw new Error('--renames must contain a JSON array.');
        const report = analyzeCallerImpact({ schemaVersion: 1, baseline, candidate, files: sources.files, scenarios,
          ...(fieldRenames === undefined ? {} : { fieldRenames }) });
        const rendered = renderCallerReport(report, options.format);
        if (options.output) {
          await writeNewCallerReport(options.output, rendered, sources.root);
          process.stderr.write(`Caller report created: ${terminalSafe(options.output)}\n`);
        }
        if (options.writePatches) {
          await exportCallerPatches(options.writePatches, report, sources.root);
          process.stderr.write(`Candidate patches exported: ${terminalSafe(options.writePatches)}. Original source is unchanged; read the verification manifest before applying changes.\n`);
        }
        if (!options.output) process.stdout.write(rendered);
        if (options.failOn !== 'never' && (report.gate === 'blocked' || (options.failOn === 'review' && report.gate === 'review'))) process.exitCode = 2;
      } catch (error) {
        process.stderr.write(`ContractGuard caller review error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`);
        process.exitCode = 1;
      }
    });
}

function parseCallerFormat(value: string): 'json' | 'markdown' {
  if (value === 'json' || value === 'markdown') return value;
  throw new InvalidArgumentError('caller review format must be json or markdown');
}

function parseCallerFailOn(value: string): 'regression' | 'review' | 'never' {
  if (value === 'regression' || value === 'review' || value === 'never') return value;
  throw new InvalidArgumentError('caller review fail-on must be regression, review, or never');
}
