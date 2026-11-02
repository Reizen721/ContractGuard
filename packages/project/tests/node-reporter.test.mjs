import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import nodeReporter, { NODE_REPORT_BYTES, parseNodeReport } from '../dist/node-reporter.js';

const workspace = resolve('synthetic-node-report-workspace');
const file = join(workspace, 'test', 'selected.test.mjs');
const allowed = ['test/selected.test.mjs'];
const summary = (overrides = {}) => ({ type: 'test:summary', data: { success: true, counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0, suites: 0, ...overrides } } });
const pair = (overrides = {}, details = {}) => {
  const data = { file, name: 'explicit named test', nesting: 0, line: 3, column: 1, ...overrides };
  return [{ type: 'test:start', data }, { type: 'test:pass', data: { ...data, details: { type: 'test', ...details } } }];
};
async function report(events) { let text = ''; for await (const line of nodeReporter(events)) text += line; return text; }
const parse = (text, selection = allowed) => parseNodeReport(text, workspace, selection);

// Shapes follow Node's documented event API, not JUnit attributes:
// https://github.com/nodejs/node/blob/v22.13.0/doc/api/test.md#event-testpass
test('Node 22 and Node 24 event shapes retain the same real file identity and omit raw output', async () => {
  const node22 = [...pair(), summary()];
  const node24 = node22.map((event) => ({ ...event, data: { ...event.data, testId: 1, parentId: 0, tags: [], entryFile: file } }));
  const expected = parse(await report(node22));
  const text = await report([{ type: 'test:stdout', data: { message: 'synthetic-private-output-must-not-be-in-structured-report' } }, ...node24]);
  assert.deepEqual(parse(text), expected);
  assert.deepEqual(expected.tests, { total: 1, passed: 1, failed: 0, skipped: 0 });
  assert.ok(!text.includes('synthetic-private-output-must-not-be-in-structured-report'));
});

test('missing, relative and unregistered event files cannot be inferred from test names', async () => {
  for (const badFile of [undefined, 'test/selected.test.mjs', join(workspace, 'test', 'unregistered.test.mjs')]) {
    const text = await report([...pair({ file: badFile, name: 'test/selected.test.mjs' }), summary()]);
    assert.throws(() => parse(text));
  }
  assert.throws(() => parseNodeReport('<testsuites><testcase name="test/selected.test.mjs"/></testsuites>', workspace, allowed));
});

test('file-level passes and incomplete configured test selections are rejected', async () => {
  assert.throws(() => parseNodeReport('', workspace, allowed));
  assert.throws(() => parseNodeReport('{}\n', workspace, allowed));
  assert.throws(() => parseNodeReport('not-json\n', workspace, allowed));
  assert.throws(() => parseNodeReport('{}\n{"type":"complete"}\n', workspace, allowed));
  assert.throws(() => parseNodeReport('', workspace, []));
  const empty = await report([...pair({ name: file }), summary()]);
  assert.throws(() => parse(empty));
  const valid = await report([...pair(), summary()]);
  assert.throws(() => parse(valid, [...allowed, 'test/missing.test.mjs']));
});

test('truncated reports, incomplete lifecycle and events after the final summary fail closed', async () => {
  const valid = await report([...pair(), summary()]);
  assert.throws(() => parse(valid.slice(0, -1)));
  assert.throws(() => parse(valid.replace('{"type":"complete"}\n', '')));
  for (const events of [
    [pair()[0], summary()], [pair()[1], summary()], [...pair(), summary(), ...pair()],
    [...pair(), summary(), summary()], [...pair()], [...pair({ nesting: 1 }), summary()],
  ]) {
    const text = await report(events); assert.throws(() => parse(text));
  }
});

test('cancellation, invalid totals and unsuccessful zero-failure reports cannot become passes', async () => {
  for (const totals of [{ tests: 2 }, { passed: 2 }, { cancelled: 1 }, { suites: 1 }, { failed: -1 }, { skipped: 0.5 }]) {
    const text = await report([...pair(), summary(totals)]); assert.throws(() => parse(text));
  }
  const unsuccessful = summary(); unsuccessful.data.success = false;
  const text = await report([...pair(), unsuccessful]); assert.throws(() => parse(text));
});

test('nested suite names and exact definition locations are part of the stable identity', async () => {
  async function nested(name, line = 4) {
    const suite = pair({ name }, { type: 'suite' });
    return parse(await report([suite[0], ...pair({ name: 'same leaf', nesting: 1, line }), suite[1], summary({ suites: 1 })]));
  }
  const before = await nested('first suite');
  assert.deepEqual(before.tests, { total: 1, passed: 1, failed: 0, skipped: 0 });
  assert.notEqual(before.identity, (await nested('different suite')).identity);
  assert.notEqual(before.identity, (await nested('first suite', 5)).identity);
});

test('skip and todo evidence remains distinguishable from executed tests', async () => {
  const skipped = pair(); skipped[1].data.skip = true;
  const todo = pair({ name: 'todo leaf', line: 5 }); todo[1].data.todo = true;
  const result = parse(await report([...skipped, ...todo, summary({ tests: 2, passed: 0, skipped: 1, todo: 1 })]));
  assert.deepEqual(result.tests, { total: 2, passed: 0, failed: 0, skipped: 2 });
  const executed = parse(await report([...pair(), summary()]));
  const oneSkipped = parse(await report([...skipped, summary({ passed: 0, skipped: 1 })]));
  assert.notEqual(executed.identity, oneSkipped.identity);
  for (const directive of ['skip', 'todo']) {
    const emptyReason = pair(); emptyReason[1].data[directive] = '';
    const emptyResult = parse(await report([...emptyReason, summary({ passed: 0, [directive === 'skip' ? 'skipped' : 'todo']: 1 })]));
    assert.deepEqual(emptyResult.tests, { total: 1, passed: 0, failed: 0, skipped: 1 });
  }
});

test('structured output is bounded while streaming and oversized identities are rejected', async () => {
  let emittedBytes = 0;
  await assert.rejects(async () => {
    for await (const line of nodeReporter([...pair({ name: 'x'.repeat(NODE_REPORT_BYTES / 2) }), summary()])) emittedBytes += Buffer.byteLength(line);
  }, /size limit/);
  assert.ok(emittedBytes <= NODE_REPORT_BYTES);
  await assert.rejects(report([...pair({ name: 'x'.repeat(NODE_REPORT_BYTES + 1) }), summary()]), /size limit/);
  assert.throws(() => parse(' '.repeat(NODE_REPORT_BYTES) + '\n'));
});
