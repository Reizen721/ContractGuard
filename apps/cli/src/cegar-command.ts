import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { terminalSafe } from './formatters.js';

interface CegarCliOptions {
  preset?: string;
  mode: 'symbolic' | 'llm' | 'hybrid';
  provider?: string;
  maxRounds: number;
  adversarial: boolean;
  format: 'json' | 'markdown';
  output?: string;
}

export function registerCegarCommand(program: Command): void {
  program
    .command('cegar')
    .description(
      'Run the Verifier-Guided Neuro-Symbolic CEGAR API Migration Agent across multi-file TypeScript callers and 4 deterministic verification gates.',
    )
    .argument('[bundle]', 'path to a CEGAR JSON bundle (or omit when using --preset)')
    .option('--preset <id>', 'run one of the built-in CEGAR showcase presets')
    .option(
      '--mode <mode>',
      'symbolic, llm, or hybrid',
      (value: string) => {
        if (value === 'symbolic' || value === 'llm' || value === 'hybrid') return value;
        throw new InvalidArgumentError('mode must be symbolic, llm, or hybrid');
      },
      'symbolic',
    )
    .option('--provider <id>', 'configured LLM profile identifier for llm or hybrid mode')
    .option(
      '--max-rounds <n>',
      'maximum CEGAR refinement rounds (1..6)',
      (value: string) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 6) {
          throw new InvalidArgumentError('max-rounds must be an integer between 1 and 6');
        }
        return parsed;
      },
      4,
    )
    .option('--no-adversarial', 'disable Gate 4 differential adversarial witness crash fuzzing')
    .option(
      '-f, --format <format>',
      'json or markdown',
      (value: string) => {
        if (value === 'json' || value === 'markdown') return value;
        throw new InvalidArgumentError('format must be json or markdown');
      },
      'markdown',
    )
    .option('-o, --output <file>', 'write the CEGAR report to a file instead of stdout')
    .action(async (bundlePath: string | undefined, options: CegarCliOptions) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      try {
        const {
          CEGAR_PRESETS,
          formatCegarReportMarkdown,
          runCegarMigration,
          validateCegarRunRequest,
        } = await import('@contractguard/api/cegar');

        let basePayload: unknown;
        if (options.preset) {
          const matched = CEGAR_PRESETS.find((p) => p.id === options.preset);
          if (!matched) {
            throw new Error(
              `Unknown preset '${options.preset}'. Available: ${CEGAR_PRESETS.map((p) => p.id).join(', ')}`,
            );
          }
          basePayload = matched.request;
        } else if (bundlePath) {
          const abs = resolve(bundlePath);
          const info = await stat(abs);
          if (!info.isFile() || info.size > 8 * 1024 * 1024) {
            throw new Error('CEGAR bundle must be a regular JSON file <= 8 MiB.');
          }
          basePayload = JSON.parse((await readFile(abs, 'utf8')).replace(/^\uFEFF/, ''));
        } else {
          throw new Error('Specify either a <bundle.json> file or --preset <id>.');
        }

        const merged = validateCegarRunRequest({
          ...(basePayload as Record<string, unknown>),
          mode: options.mode,
          maxRounds: options.maxRounds,
          enableAdversarialFuzzing: options.adversarial,
          ...(options.provider ? { providerId: options.provider } : {}),
        });

        const record = await runCegarMigration(merged, { signal: controller.signal });
        const rendered =
          options.format === 'json'
            ? `${JSON.stringify(record, null, 2)}\n`
            : formatCegarReportMarkdown(record);

        if (options.output) {
          const dest = resolve(options.output);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, rendered, 'utf8');
          process.stderr.write(`CEGAR report written to ${terminalSafe(dest)}\n`);
        } else {
          process.stdout.write(rendered);
        }

        if (record.patchStatus === 'failed') {
          process.exitCode = 2;
        }
      } catch (error) {
        process.stderr.write(
          `ContractGuard CEGAR error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`,
        );
        process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', cancel);
      }
    });
}
