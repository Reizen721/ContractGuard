import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type { ProjectPhase } from './types.js';

// Node 22's JUnit reporter omits file attributes. The documented event stream
// exposes the actual definition file in both Node 22 and 24; never infer it from names.
export const NODE_REPORT_BYTES = 1024 * 1024;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const position = (value: unknown): value is number => count(value) && value > 0;
function fail(): never { throw new Error('Incomplete or inconsistent Node test event report.'); }

/** Runs in the test-runner parent process, not in the submitted test files. */
export default async function* nodeReporter(source: AsyncIterable<{ type: string; data: RecordValue }>): AsyncGenerator<string> {
  let bytes = 0;
  const encode = (value: unknown): string => {
    const line = JSON.stringify(value) + '\n';
    bytes += Buffer.byteLength(line);
    if (bytes > NODE_REPORT_BYTES) throw new Error('Node test event report exceeds its size limit.');
    return line;
  };
  yield encode({ format: 'contractguard-node-events', schemaVersion: 1 });
  for await (const { type, data } of source) {
    if (type === 'test:start' || type === 'test:pass' || type === 'test:fail') {
      for (const value of [data.name, data.file]) if (typeof value === 'string' && value.length > NODE_REPORT_BYTES) throw new Error('Node test identity exceeds its size limit.');
      const details = record(data.details) ? data.details : {};
      yield encode({ type, name: data.name, file: data.file, line: data.line, column: data.column, nesting: data.nesting,
        ...(type === 'test:start' ? {} : { testType: details.type ?? 'test', skipped: data.skip !== undefined, todo: data.todo !== undefined }),
      });
    } else if (type === 'test:summary' && data.file === undefined) {
      const totals = record(data.counts) ? data.counts : {};
      yield encode({ type, success: data.success, counts: Object.fromEntries(['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled', 'suites'].map((key) => [key, totals[key]])) });
    }
  }
  // A killed process, reporter error, or truncated write cannot manufacture completion.
  yield encode({ type: 'complete' });
}

export function parseNodeReport(text: string, workspace: string, allowed: string[]): { tests: ProjectPhase['tests']; identity: string } {
  if (Buffer.byteLength(text) > NODE_REPORT_BYTES || !text.endsWith('\n')) fail();
  const rows: unknown[] = text.trimEnd().split('\n').map((line) => JSON.parse(line));
  const header = rows.shift(); const end = rows.pop();
  if (!record(header) || header.format !== 'contractguard-node-events' || header.schemaVersion !== 1 || !record(end) || end.type !== 'complete') fail();
  const files = new Set<string>(); const identities: unknown[][] = [];
  const stack: Array<{ file: string; name: string; line: number; column: number }> = [];
  const observed = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, suites: 0 };
  let summary: RecordValue | undefined;
  for (const event of rows) {
    if (!record(event) || summary) fail();
    if (event.type === 'test:summary') {
      if (stack.length || !record(event.counts) || typeof event.success !== 'boolean') fail();
      summary = event;
      continue;
    }
    if (!['test:start', 'test:pass', 'test:fail'].includes(String(event.type)) || !count(event.nesting)
      || typeof event.file !== 'string' || !isAbsolute(event.file) || typeof event.name !== 'string' || !event.name
      || !position(event.line) || !position(event.column)) fail();
    const file = relative(workspace, event.file).replaceAll('\\', '/');
    if (!allowed.includes(file)) throw new Error('Runner executed a test outside the configured test file list.');
    // An empty file is represented by Node as a file-level pass, not a registered test.
    if (event.name === event.file || event.name.replaceAll('\\', '/') === file || event.name === file.split('/').at(-1)) fail();
    const identity = { file, name: event.name, line: event.line, column: event.column };
    if (event.type === 'test:start') {
      if (event.nesting !== stack.length) fail();
      stack.push(identity);
      continue;
    }
    const current = stack.at(-1);
    if (stack.length !== event.nesting + 1 || !current || JSON.stringify(current) !== JSON.stringify(identity)
      || !['test', 'suite'].includes(String(event.testType)) || typeof event.skipped !== 'boolean' || typeof event.todo !== 'boolean'
      || event.skipped && event.todo) fail();
    files.add(file);
    identities.push([file, stack.map((item) => item.name), event.line, event.column, event.testType, event.skipped || event.todo ? 'skipped' : 'executed']);
    stack.pop();
    if (event.testType === 'suite') observed.suites++;
    else {
      observed.tests++;
      if (event.todo) observed.todo++;
      else if (event.skipped) observed.skipped++;
      else if (event.type === 'test:fail') observed.failed++;
      else observed.passed++;
    }
  }
  if (!summary || stack.length || !record(summary.counts)) fail();
  const totals = summary.counts;
  for (const key of ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled', 'suites']) if (!count(totals[key])) fail();
  if (totals.cancelled !== 0 || Object.entries(observed).some(([key, value]) => totals[key] !== value)
    || summary.success !== (observed.failed === 0) || observed.tests !== observed.passed + observed.failed + observed.skipped + observed.todo) fail();
  if (files.size !== allowed.length || allowed.some((file) => !files.has(file))) throw new Error('Not all configured test files produced results.');
  const tests = { total: observed.tests, passed: observed.passed, failed: observed.failed, skipped: observed.skipped + observed.todo };
  const identity = createHash('sha256').update(JSON.stringify(identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
  return { tests, identity };
}
