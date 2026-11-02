import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { analyzeCompatibility } from '../packages/core/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';

// Synthetic integration checks, not real-world accuracy measurements. Core and
// HTTP receive only explicit file text; only the CLI adapter may read files.
const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'contractguard-v13-regression-'));
const policy = { schemaVersion: 1, id: 'v13-regression-policy' };
const policyFile = join(directory, 'policy.json');
await writeFile(policyFile, JSON.stringify(policy));
const server = createApp({ dataDirectory: join(directory, 'analyses'), serveWeb: false,
  aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, rulePolicy: policy,
}).listen(0, '127.0.0.1');

function semantics(result) {
  const { engineVersion, policy, source, score, compatible, summary, changes, coverage } = result;
  return { engineVersion, policy, source, score, compatible, summary, changes, coverage };
}

async function cli(baseline, candidate, extra = []) {
  const args = [resolve('apps/cli/dist/index.js'), 'compare', baseline, candidate,
    '--format', 'json', '--policy', policyFile, ...extra];
  try {
    const { stdout } = await execute(process.execPath, args, { maxBuffer: 2 * 1024 * 1024 });
    return { result: JSON.parse(stdout), code: 0 };
  } catch (error) {
    assert.equal(error.code, 2, `CLI execution failed: ${error.stderr ?? error.message}`);
    return { result: JSON.parse(error.stdout), code: 2 };
  }
}

async function fixture(side) {
  const base = resolve('fixtures/multifile', side);
  const files = await Promise.all(['openapi.yaml', 'schemas/order.yaml'].map(async (path) => ({
    path, content: await readFile(join(base, path), 'utf8'),
  })));
  return { kind: 'bundle', entry: 'openapi.yaml', files };
}

function schemaDocument(schema, version) {
  return { openapi: version, info: { title: 'Equivalent dialects', version: '1' },
    paths: { '/value': { post: { requestBody: { content: { 'application/json': { schema } } },
      responses: { 200: { description: 'OK' } },
    } } },
  };
}

try {
  await new Promise((ready, reject) => { server.once('listening', ready); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const api = async (baseline, candidate) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/analyses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseline, candidate }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, `API analysis failed: ${JSON.stringify(body)}`);
    return body;
  };

  const [baseline, candidate] = await Promise.all([fixture('baseline'), fixture('candidate')]);
  const core = analyzeCompatibility(baseline, candidate, { policy });
  assert.ok(core.changes.some((finding) => finding.ruleId === 'SCHEMA_TYPE_CHANGED' && finding.severity === 'breaking'));
  assert.equal(core.coverage.status, 'partial', 'The fixture includes unanalysed webhooks');
  const idFinding = core.changes.find((finding) => finding.ruleId === 'SCHEMA_TYPE_CHANGED' && finding.location.includes('id'));
  assert.deepEqual(idFinding.sourceLocations, {
    old: { file: 'schemas/order.yaml', pointer: '#/properties/id/type' },
    new: { file: 'schemas/order.yaml', pointer: '#/properties/id/type' },
  }, 'Cross-file findings must point at the actual source field');
  assert.deepEqual(semantics(await api(baseline, candidate)), semantics(core), 'Explicit bundle API/core mismatch');
  const command = await cli(resolve('fixtures/multifile/baseline/openapi.yaml'),
    resolve('fixtures/multifile/candidate/openapi.yaml'), ['--bundle']);
  assert.equal(command.code, 2);
  assert.deepEqual(semantics(command.result), semantics(core), 'Filesystem bundle CLI/core mismatch');

  const reordered = analyzeCompatibility({ ...baseline, files: [...baseline.files].reverse() },
    { ...candidate, files: [...candidate.files].reverse() }, { policy });
  assert.deepEqual(semantics(reordered), semantics(core), 'Manifest order must not change fingerprints or findings');

  // Coverage is independent of the severity gate. Unsupported webhook coverage
  // is not silently translated into a breaking finding or a complete analysis.
  const partial = JSON.stringify({ openapi: '3.1.0', info: { title: 'Coverage boundary', version: '1' }, paths: {},
    webhooks: { completed: { post: { responses: { 200: { description: 'Acknowledged' } } } } },
  });
  const partialFile = join(directory, 'partial.json');
  await writeFile(partialFile, partial);
  const normalPartial = await cli(partialFile, partialFile);
  assert.equal(normalPartial.code, 0, 'Partial coverage alone must not change the default severity gate');
  assert.equal(normalPartial.result.summary.breaking, 0);
  assert.equal(normalPartial.result.coverage.status, 'partial');
  const strictPartial = await cli(partialFile, partialFile, ['--fail-on', 'never', '--fail-on-incomplete']);
  assert.equal(strictPartial.code, 2, 'The explicit incomplete gate must remain active with --fail-on never');
  assert.deepEqual(semantics(strictPartial.result), semantics(normalPartial.result), 'Gate flags cannot rewrite findings');

  // A valid dialect migration with equivalent value sets should produce no
  // structural change, for both inline schemas and local component references.
  for (const referenced of [false, true]) {
    const oldSchema = { type: 'string', nullable: true };
    const newSchema = { type: ['string', 'null'] };
    const oldDocument = schemaDocument(referenced ? { $ref: '#/components/schemas/Value' } : oldSchema, '3.0.4');
    const newDocument = schemaDocument(referenced ? { $ref: '#/components/schemas/Value' } : newSchema, '3.1.0');
    if (referenced) {
      oldDocument.components = { schemas: { Value: oldSchema } };
      newDocument.components = { schemas: { Value: newSchema } };
    }
    const oldText = JSON.stringify(oldDocument);
    const newText = JSON.stringify(newDocument);
    const equivalent = analyzeCompatibility(oldText, newText, { policy });
    assert.deepEqual(equivalent.changes, [], 'Equivalent nullable syntax must not be a breaking migration');
    assert.equal(equivalent.coverage.status, 'complete');
    assert.deepEqual(semantics(await api(oldText, newText)), semantics(equivalent));
    const oldPath = join(directory, `${referenced ? 'ref' : 'inline'}-old.json`);
    const newPath = join(directory, `${referenced ? 'ref' : 'inline'}-new.json`);
    await Promise.all([writeFile(oldPath, oldText), writeFile(newPath, newText)]);
    const compared = await cli(oldPath, newPath);
    assert.equal(compared.code, 0);
    assert.deepEqual(semantics(compared.result), semantics(equivalent));
  }
  process.stdout.write('V1.3 regression passed: multi-file core/API/CLI equality, source locations, stable manifests, independent incomplete gate, and two equivalent dialect migrations; no cloud calls.\n');
} finally {
  await new Promise((closed) => server.close(closed));
  // Exact mkdtemp-owned path only; never a workspace or user-selected path.
  await rm(directory, { recursive: true, force: true });
}
