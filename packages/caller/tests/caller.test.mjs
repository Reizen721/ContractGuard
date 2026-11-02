import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeCallerImpact, validateCallerInput, renderCallerReport, CallerInputError } from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/caller-impact/input.json', import.meta.url), 'utf8'));
function input() { return structuredClone(fixture); }
function one() { const result = input(); result.files = result.files.slice(0, 1); result.files[0].content = result.files[0].content.split('\n\n')[0]; result.scenarios = result.scenarios.slice(0, 1); result.fieldRenames = result.fieldRenames.slice(0, 1); return result; }
function control() { const result = one(); result.candidate = structuredClone(result.baseline); result.scenarios[0].candidateResponse = structuredClone(result.scenarios[0].baselineResponse); delete result.fieldRenames; return result; }
const rename = (source, from, to) => source.replace(from, to);

test('real source replay records line numbers, errors, two verified proposals and unchanged static gate', () => {
  const submitted = input(); const untouched = structuredClone(submitted);
  const result = analyzeCallerImpact(submitted);
  assert.deepEqual(result.summary, { files: 2, callsites: 3, resolved: 3, unknown: 0, checks: 3, passed: 1, regressions: 2, invalidBaselines: 0, inconclusive: 0, verifiedPatches: 2 });
  assert.equal(result.gate, 'blocked'); assert.equal(result.checks[0].baseline.value, 'ALICE'); assert.match(result.checks[0].candidate.error, /undefined/);
  assert.deepEqual(result.callsites.map((site) => site.line), [2, 8, 4]);
  assert.ok(result.callsites[0].relatedChangeIds.length > 0);
  assert.ok(result.callsites[0].relatedChangeIds.every((id) => result.contractAnalysis.changes.some((change) => change.id === id)));
  for (const patch of result.patches) { assert.equal(patch.verification.status, 'verified'); assert.equal(patch.sourceSha256.length, 64); assert.notEqual(patch.sourceSha256, patch.patchedSha256); assert.ok(patch.verification.results.every((item) => item.outcome.status === 'passed')); }
  assert.deepEqual(submitted, untouched);
});

test('unchanged caller and exact oracle pass; fingerprint is stable and changes with source', () => {
  const submitted = control(); const first = analyzeCallerImpact(submitted); const second = analyzeCallerImpact(submitted);
  assert.equal(first.gate, 'pass'); assert.equal(first.checks[0].status, 'pass'); assert.deepEqual(first.inputFingerprint, second.inputFingerprint);
  submitted.files[0].content += '\n// another revision'; assert.notEqual(analyzeCallerImpact(submitted).sourceFiles[0].sha256, first.sourceFiles[0].sha256);
});

test('an invalid baseline cannot become a newly introduced regression or verified patch', () => {
  const submitted = one(); submitted.scenarios[0].expected = 'DIFFERENT';
  const result = analyzeCallerImpact(submitted);
  assert.equal(result.summary.invalidBaselines, 1); assert.equal(result.summary.regressions, 0); assert.equal(result.summary.verifiedPatches, 0);
});

test('unsupported schema and candidate schema violations remain inconclusive', () => {
  const submitted = control(); submitted.scenarios[0].candidateResponse.body.customerName = 123;
  const result = analyzeCallerImpact(submitted); assert.equal(result.checks[0].status, 'inconclusive'); assert.equal(result.gate, 'review');
  submitted.scenarios[0].candidateResponse.body.customerName = 'Alice';
  submitted.candidate.paths['/orders/current'].get.responses['200'].content['application/json'].schema.patternProperties = { '^x': { type: 'string' } };
  assert.equal(analyzeCallerImpact(submitted).checks[0].status, 'inconclusive');
});

test('missing scenarios and detected uncovered functions cannot yield a pass or verified patch', () => {
  const submitted = control(); submitted.scenarios = []; const result = analyzeCallerImpact(submitted);
  assert.equal(result.gate, 'review'); assert.equal(result.summary.checks, 0);
  const multi = input(); multi.scenarios = multi.scenarios.filter((scenario) => scenario.id !== 'order-reference');
  const patch = analyzeCallerImpact(multi).patches.find((item) => item.file === 'orders.ts'); assert.notEqual(patch.verification.status, 'verified');
});

test('dynamic URLs are explicitly unknown; unmatched scenario operations do not execute', () => {
  const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace('orderLabel()', 'orderLabel(url: string)').replace("fetch('/orders/current')", 'fetch(url)'); submitted.scenarios[0].args = ['/orders/current'];
  const result = analyzeCallerImpact(submitted); assert.equal(result.summary.unknown, 1); assert.equal(result.checks[0].status, 'inconclusive');
  const mismatch = control(); mismatch.scenarios[0].operation.path = '/profile'; assert.equal(analyzeCallerImpact(mismatch).checks[0].status, 'inconclusive');
});

test('source comments, string literals and unrelated object properties are never renamed', () => {
  const submitted = one();
  submitted.files[0].content = submitted.files[0].content.replace('return order.customerName.toUpperCase();', 'const local = { customerName: " unchanged" };\n  // customerName remains documentation\n  return order.customerName.toUpperCase() + local.customerName;');
  submitted.scenarios[0].expected = 'ALICE unchanged';
  const result = analyzeCallerImpact(submitted); assert.equal(result.summary.verifiedPatches, 1);
  const patch = result.patches[0]; assert.equal(patch.edits.length, 1); assert.match(patch.patchedContent, /local\.customerName/); assert.match(patch.patchedContent, /customerName remains documentation/); assert.match(patch.patchedContent, /customerName: " unchanged"/);
});

test('literal bracket access may be patched; dynamic index expressions are not rewritten', () => {
  const bracket = one(); bracket.files[0].content = bracket.files[0].content.replace('order.customerName', "order['customerName']");
  const report = analyzeCallerImpact(bracket); assert.equal(report.summary.verifiedPatches, 1); assert.match(report.patches[0].patchedContent, /order\["displayName"\]/);
  const dynamic = one(); dynamic.files[0].content = dynamic.files[0].content.replace('return order.customerName', 'const field = "customerName";\n  return order[field]');
  assert.equal(analyzeCallerImpact(dynamic).patches.length, 0);
});

test('a wrong or absent rename target cannot be labelled verified', () => {
  const missing = one(); missing.fieldRenames[0].to = 'doesNotExist'; const report = analyzeCallerImpact(missing); assert.equal(report.summary.verifiedPatches, 0); assert.match(report.limitations.join(' '), /both fields must exist/);
  const wrong = one(); wrong.fieldRenames[0].to = 'id'; const wrongResult = analyzeCallerImpact(wrong); assert.equal(wrongResult.patches[0].verification.status, 'failed'); assert.equal(wrongResult.summary.verifiedPatches, 0);
});

test('all supplied scenarios in a file are rechecked after patching', () => {
  const submitted = one(); const extra = structuredClone(submitted.scenarios[0]); extra.id = 'second-value'; extra.baselineResponse.body.customerName = 'Bob'; extra.candidateResponse.body.displayName = 'Eve'; extra.expected = 'BOB'; submitted.scenarios.push(extra);
  const result = analyzeCallerImpact(submitted); assert.equal(result.patches[0].verification.results.length, 2); assert.equal(result.patches[0].verification.status, 'failed');
});

test('missing await and repeated body consumption remain unsupported, not simulated as successes', () => {
  for (const transform of [
    (source) => source.replace('await fetch', 'fetch'),
    (source) => source.replace('await response.json()', 'response.json()'),
    (source) => source.replace('return order.customerName', 'const second = await response.json();\n  return order.customerName'),
  ]) { const submitted = control(); submitted.files[0].content = transform(submitted.files[0].content); assert.equal(analyzeCallerImpact(submitted).checks[0].status, 'inconclusive'); }
});

test('shadowed bindings and unapproved imports cannot invoke the network mock', () => {
  const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace('orderLabel()', 'orderLabel(fetch: unknown)'); submitted.scenarios[0].args = [null];
  assert.equal(analyzeCallerImpact(submitted).checks[0].status, 'inconclusive');
  const module = control(); module.files[0].content = `import { readFile } from 'node:fs/promises';\n${module.files[0].content}`;
  assert.equal(analyzeCallerImpact(module).checks[0].status, 'inconclusive');
});

test('eval, process, constructors and computed prototype access are never executed', () => {
  const before = globalThis.CALLER_UNTRUSTED_MARKER;
  for (const expression of ['eval("globalThis.CALLER_UNTRUSTED_MARKER = true")', 'process.env', 'order["con" + "structor"]', 'order.__proto__', 'new Function("return 1")()']) {
    const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace('order.customerName.toUpperCase()', expression);
    const result = analyzeCallerImpact(submitted); assert.equal(result.checks[0].status, 'inconclusive', expression);
  }
  assert.equal(globalThis.CALLER_UNTRUSTED_MARKER, before);
});

test('loops, optional chains and unsupported methods remain unknown', () => {
  for (const replacement of ['while (true) {}', 'return order?.customerName.toUpperCase();', 'return order.customerName.replace(/A/g, "x");']) {
    const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace('return order.customerName.toUpperCase();', replacement);
    assert.equal(analyzeCallerImpact(submitted).checks[0].status, 'inconclusive');
  }
});

test('lexical TDZ, duplicate declarations and builtin shadowing never produce false passes', () => {
  const sources = [
    "function fetch(url) { throw new Error('blocked'); }\nexport async function orderLabel() { const r = await fetch('/orders/current'); const d = await r.json(); return d.id; }",
    "export async function orderLabel() { const fetch = await fetch('/orders/current'); const d = await fetch.json(); return d.id; }",
    "export async function orderLabel() { const r = await fetch('/orders/current'); const d = await r.json(); const x = d.id; { const y = x; const x = 'wrong'; return y; } }",
    "export async function orderLabel(undefined: string) { const r = await fetch('/orders/current'); const d = await r.json(); return d.id === undefined; }",
    "export async function orderLabel() { const r = await fetch('/orders/current'); const d = await r.json(); const x = 'first'; const x = d.id; return x; }",
    "function String() { return 'changed'; }\nexport async function orderLabel() { const r = await fetch('/orders/current'); const d = await r.json(); return String(d.id); }",
  ];
  for (const source of sources) {
    const submitted = control(); submitted.files[0].content = source; submitted.scenarios[0].expected = source.includes('d.id === undefined') ? false : 'ORD-101'; submitted.scenarios[0].args = source.includes('undefined: string') ? ['ORD-101'] : [];
    const result = analyzeCallerImpact(submitted); assert.equal(result.checks[0].status, 'inconclusive', source); assert.equal(result.gate, 'review');
  }
});

test('if and switch branches are interpreted from actual source, including explicit throw', () => {
  const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace('return order.customerName.toUpperCase();', 'if (response.status !== 200) throw new Error("bad status");\n switch (order.customerName) { case "Alice": return "ALICE"; default: throw new Error("unknown customer"); }');
  assert.equal(analyzeCallerImpact(submitted).checks[0].status, 'pass');
  submitted.scenarios[0].candidateResponse.body.customerName = 'Bob'; const report = analyzeCallerImpact(submitted); assert.equal(report.checks[0].status, 'regression'); assert.match(report.checks[0].candidate.error, /unknown customer/);
});

test('strict input bounds, path identity and JSON safety reject malformed requests', () => {
  const cases = [
    (v) => { v.extra = true; }, (v) => { v.files[0].path = '../escape.ts'; },
    (v) => { v.files.push({ ...v.files[0], path: 'ORDERS.ts' }); },
    (v) => { v.files[0].content = 'x'.repeat(256 * 1024 + 1); },
    (v) => { delete v.scenarios[0].expected; }, (v) => { v.scenarios.push(structuredClone(v.scenarios[0])); },
    (v) => { v.scenarios[0].expected = NaN; }, (v) => { v.scenarios[0].args = new Array(2); },
    (v) => { v.fieldRenames[0].to = 'constructor'; }, (v) => { v.files[0].path = 'CON.ts'; },
  ];
  for (const mutate of cases) { const submitted = one(); mutate(submitted); assert.throws(() => validateCallerInput(submitted), CallerInputError); }
  const cycle = one(); cycle.scenarios[0].expected = cycle; assert.throws(() => validateCallerInput(cycle), CallerInputError);
  const getter = one(); let called = false; Object.defineProperty(getter, 'danger', { enumerable: true, get() { called = true; return 1; } }); assert.throws(() => validateCallerInput(getter), CallerInputError); assert.equal(called, false);
  const polluted = one(); polluted.scenarios[0].expected = JSON.parse('{"__proto__":{"polluted":true}}'); assert.throws(() => validateCallerInput(polluted), CallerInputError); assert.equal({}.polluted, undefined);
});

test('unsupported files and exported SDK calls cannot hide behind another passing file', () => {
  const submitted = control(); submitted.files.push({ path: 'sdk.ts', content: "export async function sdkCaller() { const response = await serviceClient.get('/orders/current'); return response.data.id; }" });
  const result = analyzeCallerImpact(submitted); assert.equal(result.gate, 'review'); assert.match(result.limitations.join(' '), /sdk\.ts.*unverified/);
  const same = control(); same.files[0].content += '\nexport async function sdkCaller() { return await serviceClient.read(); }';
  assert.equal(analyzeCallerImpact(same).gate, 'review');
});

test('unsupported transport arguments are unknown rather than silently ignored', () => {
  for (const options of ["{body:'payload'}", "{redirect:'invalid'}", '{headers:123}']) {
    const submitted = control(); submitted.files[0].content = submitted.files[0].content.replace("fetch('/orders/current')", `fetch('/orders/current', ${options})`);
    const result = analyzeCallerImpact(submitted); assert.equal(result.checks[0].status, 'inconclusive'); assert.equal(result.gate, 'review');
  }
  const axios = input(); axios.files[1].content = axios.files[1].content.replace("axios.get('/profile')", "axios.get('/profile', {headers:123})");
  assert.equal(analyzeCallerImpact(axios).checks[2].status, 'inconclusive');
});

test('amplified strings and aliased object trees stop within runtime value budgets', () => {
  for (const initializer of ['"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"', '{x:"value"}']) {
    const submitted = control(); const definitions = [`const v0 = ${initializer};`];
    for (let i = 1; i < 25; i++) definitions.push(initializer.startsWith('"') ? `const v${i} = v${i - 1} + v${i - 1};` : `const v${i} = {a:v${i - 1},b:v${i - 1}};`);
    submitted.files[0].content = submitted.files[0].content.replace('return order.customerName.toUpperCase();', `${definitions.join('\n')}\nreturn v24;`);
    const result = analyzeCallerImpact(submitted); assert.equal(result.checks[0].status, 'inconclusive'); assert.match(result.checks[0].baseline.error, /budget/);
  }
});

test('reports retain exact JSON and render source/patch text as non-executable markdown', () => {
  const report = analyzeCallerImpact(input()); assert.deepEqual(JSON.parse(renderCallerReport(report, 'json')), report);
  const markdown = renderCallerReport(report, 'markdown'); assert.match(markdown, /bounded-typescript-replay/); assert.match(markdown, /orders\.ts:2:/); assert.match(markdown, /    --- a\/orders\.ts/); assert.match(markdown, /not Node\.js execution/);
});
