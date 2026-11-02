import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { analyzeCompatibility } from '../packages/core/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';

// Hand-labelled, synthetic atomic cases. This is a regression matrix, not an
// estimate of detection accuracy on real-world APIs. No LLM is called.
function schemaDocument(schema, version = '3.0.4') {
  return {
    openapi: version,
    info: { title: 'ContractGuard V1.2 regression', version: '1' },
    paths: {
      '/probe': {
        post: {
          requestBody: { content: { 'application/json': { schema } } },
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  };
}

function parameterDocument(options) {
  const document = schemaDocument({ type: 'string' });
  document.paths['/probe'].post.parameters = [{
    name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string' } }, ...options,
  }];
  return document;
}

const withHeader = schemaDocument({ type: 'string' });
withHeader.paths['/probe'].post.responses[200].headers = {
  'X-Next-Cursor': { schema: { type: 'string' }, description: 'Pagination cursor' },
};
const cases = [
  {
    id: 'oas30-exclusive-minimum',
    baseline: schemaDocument({ type: 'number', minimum: 0, exclusiveMinimum: false }),
    candidate: schemaDocument({ type: 'number', minimum: 0, exclusiveMinimum: true }),
    ruleId: 'SCHEMA_CONSTRAINT_TIGHTENED', severity: 'breaking',
  },
  {
    id: 'oas30-exclusive-maximum',
    baseline: schemaDocument({ type: 'number', maximum: 10, exclusiveMaximum: false }),
    candidate: schemaDocument({ type: 'number', maximum: 10, exclusiveMaximum: true }),
    ruleId: 'SCHEMA_CONSTRAINT_TIGHTENED', severity: 'breaking',
  },
  {
    id: 'oas31-exclusive-minimum',
    baseline: schemaDocument({ type: 'number', minimum: 0 }, '3.1.0'),
    candidate: schemaDocument({ type: 'number', exclusiveMinimum: 0 }, '3.1.0'),
    ruleId: 'SCHEMA_CONSTRAINT_TIGHTENED', severity: 'breaking',
  },
  {
    id: 'oneof-overlap-is-not-safe',
    baseline: schemaDocument({ oneOf: [{ type: 'integer' }] }),
    candidate: schemaDocument({ oneOf: [{ type: 'integer' }, { type: 'number' }] }),
    ruleId: 'SCHEMA_COMPOSITION_CHANGED', severity: 'potentially-breaking',
  },
  {
    id: 'parameter-explode-changed',
    baseline: parameterDocument({ style: 'form', explode: true }),
    candidate: parameterDocument({ style: 'form', explode: false }),
    ruleId: 'PARAMETER_SERIALIZATION_CHANGED', severity: 'potentially-breaking',
  },
  {
    id: 'parameter-explicit-defaults-equivalent',
    baseline: parameterDocument({ style: 'form', explode: true, allowReserved: false }),
    candidate: parameterDocument({}),
    noChanges: true,
  },
  {
    id: 'response-header-removed',
    baseline: withHeader,
    candidate: schemaDocument({ type: 'string' }),
    ruleId: 'RESPONSE_HEADER_REMOVED', severity: 'potentially-breaking',
  },
  {
    id: 'optional-typed-property-on-open-request',
    baseline: schemaDocument({ type: 'object' }),
    candidate: schemaDocument({ type: 'object', properties: { note: { type: 'string' } } }),
    ruleId: 'SCHEMA_PROPERTY_ADDED', severity: 'breaking',
  },
];

function semanticResult(result) {
  const { engineVersion, policy, source, score, compatible, summary, changes } = result;
  return { engineVersion, policy, source, score, compatible, summary, changes };
}

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'contractguard-v12-regression-'));
const server = createApp({ dataDirectory: join(directory, 'analyses'), serveWeb: false,
  aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' },
}).listen(0, '127.0.0.1');

try {
  await new Promise((ready, reject) => {
    server.once('listening', ready);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (const testCase of cases) {
    const baseline = JSON.stringify(testCase.baseline);
    const candidate = JSON.stringify(testCase.candidate);
    const core = analyzeCompatibility(baseline, candidate);
    if (testCase.noChanges) assert.deepEqual(core.changes, [], testCase.id);
    else assert.ok(core.changes.some((change) => change.ruleId === testCase.ruleId
      && change.severity === testCase.severity), `${testCase.id}: missing expected finding`);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/analyses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline, candidate }),
    });
    assert.equal(response.status, 201, `${testCase.id}: API status`);
    assert.deepEqual(semanticResult(await response.json()), semanticResult(core), `${testCase.id}: API/core mismatch`);

    const baselinePath = join(directory, `${testCase.id}-old.json`);
    const candidatePath = join(directory, `${testCase.id}-new.json`);
    await Promise.all([writeFile(baselinePath, baseline), writeFile(candidatePath, candidate)]);
    let stdout;
    let exitCode = 0;
    try {
      ({ stdout } = await run(process.execPath, [resolve('apps/cli/dist/index.js'),
        'compare', baselinePath, candidatePath, '--format', 'json'], { maxBuffer: 1024 * 1024 }));
    } catch (error) {
      assert.equal(error.code, 2, `${testCase.id}: CLI execution error: ${error.stderr ?? error.message}`);
      stdout = error.stdout;
      exitCode = 2;
    }
    assert.equal(exitCode, core.summary.breaking > 0 ? 2 : 0, `${testCase.id}: CLI gate mismatch`);
    assert.deepEqual(semanticResult(JSON.parse(stdout)), semanticResult(core), `${testCase.id}: CLI/core mismatch`);
  }
  process.stdout.write(`V1.2 regression passed: ${cases.length} atomic cases agree across core, API, and CLI; no cloud calls.\n`);
} finally {
  await new Promise((closed) => server.close(closed));
  // The target is the exact directory returned by mkdtemp, not a user path.
  await rm(directory, { recursive: true, force: true });
}
