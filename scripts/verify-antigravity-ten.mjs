#!/usr/bin/env node
// Read-only verification of records already created by an Antigravity host test.
// This script never invokes a model, creates an analysis, or changes host settings.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const usage = () => {
  console.log('Usage: node scripts/verify-antigravity-ten.mjs --prefix UNIQUE_PREFIX --output NEW_DIRECTORY');
  console.log('Requires baselineName="PREFIX CG-CODEX-01 baseline" and candidateName="PREFIX CG-CODEX-01 candidate", through case 10.');
  console.log('Submit fixture baseline/candidate as JSON objects: object fingerprints are not interchangeable with raw text fingerprints.');
  console.log('GET requests only, to http://127.0.0.1:8080. The output directory must not exist.');
  console.log('This verifies persisted data, not Antigravity model selection or actual host tool calls; UI evidence is required separately.');
};
if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
  usage();
  process.exit(0);
}
const options = {};
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  const value = argv[index + 1];
  if (!['--prefix', '--output'].includes(key) || !value || value.startsWith('--') || options[key] !== undefined) {
    throw new Error('Use exactly one --prefix and one --output, each followed by a value.');
  }
  options[key] = value;
}
const prefix = options['--prefix'];
if (!prefix || prefix !== prefix.trim() || /[\u0000-\u001f\u007f]/.test(prefix) || prefix.length > 160) {
  throw new Error('Provide a nonempty unique prefix, without surrounding whitespace or control characters, at most 160 characters.');
}
if (!options['--output']) throw new Error('--output NEW_DIRECTORY is required.');
const output = path.resolve(options['--output']);
const fixturePath = path.join(root, 'fixtures/agent-plugin/codex-ten-cases.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.cases.length, 10, 'Expected the existing ten-case fixture.');
assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, 10, 'Fixture case IDs must be unique.');
for (const entry of fixture.cases) {
  assert.deepEqual(Object.keys(entry.expected).sort(), ['compatible', 'ruleIds', 'severities', 'summary'].sort(),
    `Expected fields changed for ${entry.id}; update this verifier before claiming full verification.`);
}
let fingerprintOpenApiInput;
try {
  ({ fingerprintOpenApiInput } = await import(pathToFileURL(path.join(root, 'packages/core/dist/fingerprint.js')).href));
} catch (error) {
  throw new Error('Build ContractGuard first (pnpm build); the core fingerprint helper is required.', { cause: error });
}
// Exclusive creation prevents overwriting prior evidence. Its parent directory must already exist.
await mkdir(output);
const apiUrl = 'http://127.0.0.1:8080';
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  prefix,
  apiUrl,
  fixture: 'fixtures/agent-plugin/codex-ten-cases.json',
  method: 'Read-only GET of persisted analyses; exact fixture outcomes and canonical JSON-object source fingerprints.',
  requests: [],
  hostToolTrace: {
    verified: false,
    required: 'Separate Antigravity UI evidence must show the selected model, actual tool invocations and returned analysis IDs.',
    boundary: 'HTTP records alone cannot establish which host or model created them, or whether it used MCP tools.',
  },
  apiWrites: 0,
  modelInvocations: 0,
  globalConfigurationChanged: false,
  errors: [],
  cases: [],
};
async function getJson(endpoint) {
  report.requests.push({ method: 'GET', endpoint });
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`GET ${endpoint} returned HTTP ${response.status}.`);
  return response.json();
}
const save = async (name, value) => writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const message = (error) => error instanceof Error ? error.message : String(error);
try {
  const history = await getJson('/api/analyses');
  assert.ok(Array.isArray(history.analyses), 'History response must contain analyses array.');
  // Prefix matching also catches malformed names belonging to this unique test run.
  const selected = history.analyses.filter((item) => typeof item.baselineName === 'string' && item.baselineName.startsWith(prefix));
  report.matchedHistoryRecords = selected.length;
  const knownNames = new Set(fixture.cases.map((entry) => `${prefix} ${entry.id} baseline`));
  const unknown = selected.filter((item) => !knownNames.has(item.baselineName));
  report.unexpectedNames = unknown.map((item) => ({ id: item.id, baselineName: item.baselineName }));
  if (unknown.length) report.errors.push('Prefix matched records with unexpected baseline names.');
  if (selected.length !== 10) report.errors.push(`Expected exactly 10 matching history records, found ${selected.length}.`);
  if (new Set(selected.map((item) => item.id)).size !== selected.length) report.errors.push('Matching history records contain duplicate analysis IDs.');
  await save('matching-history.json', { prefix, analyses: selected });
  const fetched = new Map();
  for (const item of selected) {
    if (fetched.has(item.id)) continue;
    if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)) {
      fetched.set(item.id, { error: 'History returned an invalid UUID; no detail request was sent.' });
      continue;
    }
    try {
      fetched.set(item.id, { record: await getJson(`/api/analyses/${item.id}`) });
    } catch (error) {
      fetched.set(item.id, { error: message(error) });
    }
  }
  for (const test of fixture.cases) {
    const baselineName = `${prefix} ${test.id} baseline`;
    const candidateName = `${prefix} ${test.id} candidate`;
    const matches = selected.filter((item) => item.baselineName === baselineName);
    const entry = { id: test.id, title: test.title, expected: test.expected, status: 'failed', matchingIds: matches.map((item) => item.id) };
    try {
      assert.equal(matches.length, 1, `Expected exactly one record for ${test.id}; found ${matches.length}.`);
      const historyItem = matches[0];
      const detail = fetched.get(historyItem.id);
      if (detail?.error) throw new Error(detail.error);
      const record = detail?.record;
      assert.ok(record && typeof record === 'object', 'Missing saved analysis.');
      entry.analysisId = record.id;
      await save(`${test.id}-analysis.json`, record);
      assert.equal(record.id, historyItem.id);
      assert.equal(record.baselineName, baselineName);
      assert.equal(record.candidateName, candidateName);
      for (const key of ['baselineName', 'candidateName', 'createdAt', 'score', 'compatible', 'summary']) {
        assert.deepEqual(record[key], historyItem[key], `History/detail mismatch: ${key}`);
      }
      const fingerprints = { old: fingerprintOpenApiInput(test.baseline), new: fingerprintOpenApiInput(test.candidate) };
      assert.deepEqual(record.source?.old?.fingerprint, fingerprints.old, 'Baseline source fingerprint differs from exact fixture object.');
      assert.deepEqual(record.source?.new?.fingerprint, fingerprints.new, 'Candidate source fingerprint differs from exact fixture object.');
      assert.equal(record.source.old.openapi, test.baseline.openapi);
      assert.equal(record.source.new.openapi, test.candidate.openapi);
      assert.ok(Array.isArray(record.changes), 'Changes must be an array.');
      const actual = {
        compatible: record.compatible,
        ruleIds: record.changes.map((item) => item.ruleId).sort(),
        severities: record.changes.map((item) => item.severity).sort(),
        summary: record.summary,
      };
      entry.actual = { ...actual, score: record.score, coverage: record.coverage?.status };
      assert.deepEqual(actual, {
        ...test.expected,
        ruleIds: [...test.expected.ruleIds].sort(),
        severities: [...test.expected.severities].sort(),
      }, 'Stored result differs from predefined expected outcome.');
      assert.equal(record.coverage?.status, 'complete', 'Unexpected partial coverage.');
      entry.fingerprints = fingerprints;
      entry.sourceFingerprintsMatched = true;
      entry.historyMatched = true;
      entry.status = 'passed';
    } catch (error) {
      entry.error = message(error);
    }
    report.cases.push(entry);
  }
} catch (error) {
  report.errors.push(message(error));
}
report.passed = report.cases.filter((entry) => entry.status === 'passed').length;
report.failed = report.cases.filter((entry) => entry.status !== 'passed').length;
report.notVerified = fixture.cases.length - report.cases.length;
report.uniqueAnalysisIds = new Set(report.cases.map((entry) => entry.analysisId).filter(Boolean)).size;
report.dataVerificationPassed = report.errors.length === 0 && report.passed === 10 && report.uniqueAnalysisIds === 10;
report.status = report.dataVerificationPassed ? 'persisted-data-verified; host-UI-evidence-still-required' : 'persisted-data-verification-failed';
report.finishedAt = new Date().toISOString();
await save('results.json', report);
console.log(JSON.stringify({ output, status: report.status, passed: report.passed, failed: report.failed, notVerified: report.notVerified, errors: report.errors, hostToolTraceVerified: false }, null, 2));
if (!report.dataVerificationPassed) process.exitCode = 1;
