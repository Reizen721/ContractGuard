import { lstat, writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { analyzeRelease, type AnalysisResult } from '@contractguard/core';
import { analyzeCallerImpact, type CallerImpactReport } from '@contractguard/caller';
import { ProjectRegistry, runProjectTests, type ProjectMetadata, type ProjectTestReport } from '@contractguard/project';
import { terminalSafe } from './formatters.js';

interface ProjectCommandOptions { registry: string; format: 'json' | 'markdown'; output?: string; failOn: 'regression' | 'review' | 'never' }
interface Review { schemaVersion: 1; project: ProjectMetadata; contractAnalysis: AnalysisResult; caller?: CallerImpactReport; tests: ProjectTestReport; gate: 'pass' | 'review' | 'blocked' }
function render(report: Review): string {
  const cell = (text: string) => terminalSafe(text).replace(/([\\`*_{}\[\]<>|])/g, '\\$1');
  const rows = (['baseline', 'candidate', 'patched'] as const).flatMap((phase) => {
    const result = report.tests[phase]; return result ? [`| ${phase} | ${result.status} | ${result.tests.passed} | ${result.tests.failed} | ${result.tests.skipped} | ${result.exitCode ?? '—'} |`] : [];
  });
  return ['# ContractGuard project migration review', '', `Project: **${cell(report.project.label)}** (\`${cell(report.project.id)}\`)`, '', `Gate: **${report.gate}**; existing-test outcome: **${report.tests.status}**; candidate patch: **${report.tests.patchStatus}**.`, '', `Snapshot SHA-256: \`${report.project.snapshotFingerprint.value}\``, '', '| Phase | Result | Passed | Failed | Skipped | Exit |', '| --- | --- | --- | --- | --- | --- |', ...rows, '', '## Existing test files', '', ...report.project.testFiles.map((file) => `- ${cell(file)}`), '', '## Contract findings', '', `Breaking: ${report.contractAnalysis.summary.breaking}; potential: ${report.contractAnalysis.summary.potentiallyBreaking}; coverage: ${report.contractAnalysis.coverage?.status ?? 'unknown'}.`, '', ...report.contractAnalysis.changes.map((change) => `- ${cell(change.id)} / ${cell(change.ruleId)}: ${cell(change.location)} — ${cell(change.message)}`), '', ...(report.caller ? ['## Caller source evidence', '', `Callsites: ${report.caller.summary.callsites}; regressions: ${report.caller.summary.regressions}; unknown: ${report.caller.summary.unknown}; AST-verified proposals: ${report.caller.summary.verifiedPatches}.`, ''] : []), '## Limitations', '', ...report.tests.limitations.map((item) => `- ${cell(item)}`), '', 'A passing selected test set does not clear an existing static contract risk. JSON includes the bounded local test output and full caller report.', ''].join('\n');
}
export function registerProjectCommand(program: Command): void {
  program.command('review-project')
    .description('Review a trusted locally registered project, reuse response fixtures, and run its existing Node/Vitest tests in source copies. Executes trusted project code; not an OS sandbox.')
    .argument('<project-id>', 'identifier in the operator-owned project registry')
    .requiredOption('--registry <file>', 'local registry defining trusted project roots, fixed tests and JSON fixture overlays')
    .option('-f, --format <format>', 'json or markdown', (value: string) => { if (value !== 'json' && value !== 'markdown') throw new InvalidArgumentError('format must be json or markdown'); return value; }, 'markdown')
    .option('-o, --output <new-file>', 'create a new report file; never overwrite an existing file')
    .option('--fail-on <level>', 'regression (blocked), review (blocked/unknown), or never', (value: string) => { if (!['regression', 'review', 'never'].includes(value)) throw new InvalidArgumentError('fail-on must be regression, review, or never'); return value; }, 'review')
    .action(async (id: string, options: ProjectCommandOptions) => {
      const controller = new AbortController(); const cancel = () => controller.abort(); process.once('SIGINT', cancel);
      try {
        if (options.output) {
          const exists = await lstat(options.output).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
          if (exists) throw new Error('The report destination already exists; select a new file.');
        }
        const prepared = await new ProjectRegistry(options.registry).prepare(id);
        const caller = prepared.caller ? analyzeCallerImpact(prepared.caller) : undefined;
        const native = caller?.contractAnalysis ?? analyzeRelease(prepared.baseline, prepared.candidate);
        const tests = await runProjectTests(prepared, { ...(caller ? { patches: caller.patches } : {}), signal: controller.signal });
        const blocked = native.summary.breaking > 0 || caller?.gate === 'blocked' || tests.status === 'regression';
        const unknown = native.summary.potentiallyBreaking > 0 || native.coverage?.status !== 'complete' || caller?.gate === 'review' || ['invalid-baseline', 'inconclusive'].includes(tests.status);
        const report: Review = { schemaVersion: 1, project: prepared.metadata, contractAnalysis: native, ...(caller ? { caller } : {}), tests, gate: blocked ? 'blocked' : unknown ? 'review' : 'pass' };
        const contents = options.format === 'json' ? JSON.stringify(report, null, 2) + '\n' : render(report);
        if (options.output) { await writeFile(options.output, contents, { encoding: 'utf8', flag: 'wx' }); process.stderr.write(`Project review saved: ${terminalSafe(options.output)}\n`); }
        else process.stdout.write(contents);
        if (options.failOn !== 'never' && (report.gate === 'blocked' || options.failOn === 'review' && report.gate === 'review')) process.exitCode = 2;
      } catch (error) { process.stderr.write(`ContractGuard project review error: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; }
      finally { process.removeListener('SIGINT', cancel); }
    });
}
