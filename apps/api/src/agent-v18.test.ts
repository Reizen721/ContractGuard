import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { CallerImpactInput } from '@contractguard/caller';
import { AgentManager, type AgentOptions, type AgentObservation, type AgentPlanner, type AgentToolRunner } from './agent/manager.js';
import { createAgentRouter } from './agent/router.js';
import { CallerReviewStore } from './caller/store.js';

const callerInput = JSON.parse(await readFile(new URL('../../../fixtures/caller-impact/input.json', import.meta.url), 'utf8')) as CallerImpactInput;
const upstream: AgentToolRunner = { status: async () => ({ available: true, pinnedVersion: '1.35.0', version: '1.35.0' }), run: async () => ({ version: '1.35.0', args: [], exitCode: 0, stdout: '[]', stderr: '', durationMs: 0 }) };
const callerRequest = () => ({ baseline: callerInput.baseline, candidate: callerInput.candidate, caller: { files: callerInput.files, scenarios: callerInput.scenarios, fieldRenames: callerInput.fieldRenames } });
function controlledPlanner(observations: AgentObservation[]): AgentPlanner {
  return { status: () => ({ available: true, allowProfileOverride: false, providers: [] }), assertAvailable() {}, async decide(value) {
    observations.push(structuredClone(value));
    return { tool: value.availableTools.includes('finish') ? 'finish' : value.availableTools[0]!, purpose: '执行必要检查', ...(value.availableTools.includes('finish') ? { recommendations: [{ title: '复核调用方迁移', actions: ['按已有测试证据复核'], evidenceIds: value.knownEvidenceIds.filter((id) => id.startsWith('CALLER-') || id.startsWith('PROJECT-')).slice(0, 6) }] } : {}) };
  } };
}

describe('V1.8 Agent caller and trusted project bridge', () => {
  let directory: string; let managers: AgentManager[];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-agent-v18-')); managers = []; });
  afterEach(async () => { for (const manager of managers) await manager.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true }); });
  const create = (options: Partial<AgentOptions> = {}) => { const value = new AgentManager({ dataDirectory: join(directory, 'runs'), callerDataDirectory: join(directory, 'callers'), aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, runner: upstream, ...options }); managers.push(value); return value; };
  async function project(slow = false, invalidBaseline = false): Promise<string> {
    const root = join(directory, 'project');
    const schema = (field: string) => ({ openapi: '3.0.3', info: { title: 'Trusted test', version: '1' }, paths: { '/profile': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } } } } } } } } });
    const entries: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'src/client.ts': "export async function loadLabel() { const response = await fetch('/profile'); const data = await response.json(); return data.name.toUpperCase(); }\n",
      'contracts/base.json': JSON.stringify(schema('name')),
      'contracts/next.json': JSON.stringify(schema(invalidBaseline ? 'name' : 'displayName')),
      'fixtures/baseline.json': JSON.stringify({ name: invalidBaseline ? 'Wrong' : 'Alice' }),
      'fixtures/candidate.json': JSON.stringify(invalidBaseline ? { name: 'Alice' } : { displayName: 'Alice' }),
      'fixtures/response.json': JSON.stringify({ name: 'Alice' }),
      'fixtures/expected.json': JSON.stringify('ALICE'),
      'fixtures/renames.json': JSON.stringify(invalidBaseline ? [] : [{ method: 'GET', path: '/profile', from: 'name', to: 'displayName' }]),
      'test/client.test.mjs': `import test from 'node:test'; import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {loadLabel} from '../src/client.ts';
test('existing label test', async()=>{ console.log('PROJECT-OUTPUT-PRIVATE-718'); ${slow ? "await new Promise(r=>setTimeout(r,20000));" : ''} const body=JSON.parse(await readFile(new URL('../fixtures/response.json',import.meta.url),'utf8')); globalThis.fetch=async()=>({json:async()=>body}); assert.equal(await loadLabel(),'ALICE'); });`,
    };
    for (const [file, contents] of Object.entries(entries)) { const destination = join(root, file); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, contents); }
    const config = join(directory, 'projects.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'demo', label: 'Trusted order', root: 'project', include: ['src', 'test', 'fixtures', 'contracts', 'package.json'], baseline: 'contracts/base.json', candidate: 'contracts/next.json', caller: { files: ['src/client.ts'], fieldRenames: 'fixtures/renames.json', fixtureScenarios: [{ id: 'label', file: 'src/client.ts', exportName: 'loadLabel', operation: { method: 'GET', path: '/profile' }, baselineResponse: { status: 200, bodyFile: 'fixtures/baseline.json' }, candidateResponse: { status: 200, bodyFile: 'fixtures/candidate.json' }, expectedFile: 'fixtures/expected.json' }] }, tests: { trusted: true, runner: 'node-test', files: ['test/client.test.mjs'], timeoutMs: 30000, baseline: [{ target: 'fixtures/response.json', source: 'fixtures/baseline.json' }], candidate: [{ target: 'fixtures/response.json', source: 'fixtures/candidate.json' }] } }] }));
    return config;
  }

  it('executes mandatory caller analysis, shares full caller history, and preserves original gate', async () => {
    const manager = create(); const run = await manager.wait((await manager.submit(callerRequest())).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(run.verdict, 'blocked');
    assert.equal(run.steps.at(-1)?.tool, 'caller-analysis'); assert.equal(run.requiredTools?.length, 6);
    assert.equal(run.callerReview?.summary.regressions, 2); assert.equal(run.callerReview?.summary.verifiedPatches, 2);
    const saved = await new CallerReviewStore(join(directory, 'callers')).get(run.callerReview!.id);
    assert.equal(saved?.report.patches.length, 2); assert.ok(saved?.report.patches[0]?.patchedContent);
    assert.ok(run.callerReview?.checks.every((check) => check.id === `CALLER-${check.sourceCheckId}`));
    assert.doesNotMatch(JSON.stringify(run), /patchedContent|toUpperCase\(\)|alice@example\.test/);
    await manager.close(); const restarted = create(); assert.deepEqual(await restarted.get(run.id), run);
  });

  it('runs registered tests in three real phases and keeps source unchanged', async () => {
    const config = await project(); const source = await readFile(join(directory, 'project/src/client.ts'), 'utf8');
    const manager = create({ projectConfigPath: config }); const list = await manager.listProjects();
    assert.equal(list[0]?.id, 'demo'); assert.doesNotMatch(JSON.stringify(list), /root|commands|contracts/);
    const run = await manager.wait((await manager.submit({ projectId: 'demo' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(run.requiredTools?.length, 7);
    assert.deepEqual(run.steps.slice(-2).map((step) => step.tool), ['caller-analysis', 'project-tests']);
    assert.equal(run.projectTests?.status, 'regression'); assert.equal(run.projectTests?.baseline.tests.passed, 1);
    assert.equal(run.projectTests?.candidate.tests.failed, 1); assert.equal(run.projectTests?.patched?.tests.passed, 1);
    assert.equal(run.projectTests?.patchStatus, 'verified'); assert.equal(run.verdict, 'blocked');
    assert.doesNotMatch(run.summary, /未能完成验证|未提交独立调用方验证证据/); assert.match(run.summary, /源码回归 1 项/);
    assert.equal(await readFile(join(directory, 'project/src/client.ts'), 'utf8'), source);
    assert.match(run.projectTests!.baseline.output, /PROJECT-OUTPUT-PRIVATE-718/);
    assert.ok(run.inputFingerprints.project?.value); assert.equal(run.projectTests?.snapshotFingerprint.value, run.project?.snapshotFingerprint.value);
  });

  it('LLM receives actual caller/test IDs and bounded summaries without source, payload or test output', async () => {
    const config = await project(); const observations: AgentObservation[] = [];
    const manager = create({ projectConfigPath: config, planner: controlledPlanner(observations) });
    const run = await manager.wait((await manager.submit({ projectId: 'demo', mode: 'llm' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const last = observations.at(-1)!; assert.ok(last.knownEvidenceIds.includes('PROJECT-PATCHED'));
    assert.ok(last.knownEvidenceIds.some((id) => id.startsWith('CALLER-CHECK'))); assert.equal(last.counts.projectTestStatus, 'regression');
    assert.doesNotMatch(JSON.stringify(observations), /PROJECT-OUTPUT-PRIVATE-718|ALICE|toUpperCase|patchedContent|baselineResponse/);
    const afterValidation = observations.find((item) => item.completedTools.includes('validate-candidate'))!;
    assert.ok(afterValidation.availableTools.includes('caller-analysis')); assert.ok(!afterValidation.availableTools.includes('project-tests')); assert.ok(!afterValidation.availableTools.includes('finish'));
    assert.equal(run.verdict, 'blocked');
  });

  it('invalid baseline testing remains review rather than a new regression', async () => {
    const config = await project(false, true); const manager = create({ projectConfigPath: config });
    const run = await manager.wait((await manager.submit({ projectId: 'demo' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(run.projectTests?.status, 'invalid-baseline');
    assert.equal(run.callerReview?.summary.regressions, 0); assert.equal(run.verdict, 'review');
  });

  it('rejects project overrides, missing IDs and caller contract overrides before creating history', async () => {
    const manager = create({ projectConfigPath: await project() });
    for (const value of [{ projectId: 'demo', baseline: {} }, { projectId: 'demo', command: 'node' }, { projectId: '../outside' }, { projectId: 'missing' }, { ...callerRequest(), caller: { ...callerRequest().caller, baseline: {} } }]) await assert.rejects(manager.submit(value));
    assert.deepEqual(await manager.list(), []);
  });

  it('HTTP exposes project IDs and linked caller/test results without accepting executable configuration', async () => {
    const app = express(); app.use(express.json({ limit: '2mb' }));
    let manager: AgentManager | undefined;
    app.use('/api/agent', createAgentRouter({ dataDirectory: join(directory, 'http-runs'), callerDataDirectory: join(directory, 'callers'), projectConfigPath: await project(), runner: upstream, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, onManager: (value) => { manager = value; managers.push(value); } }));
    assert.equal((await request(app).get('/api/agent/projects').expect(200)).body.projects[0].id, 'demo');
    await request(app).post('/api/agent/runs').send({ projectId: 'demo', testCommand: 'anything' }).expect(400);
    const response = await request(app).post('/api/agent/runs').send({ projectId: 'demo' }).expect(202);
    const run = await manager!.wait(response.body.id);
    const markdown = (await request(app).get(`/api/agent/runs/${run.id}/report?format=markdown`).expect(200)).text;
    assert.match(markdown, /PROJECT-PATCHED/); assert.match(markdown, new RegExp(run.callerReview!.id));
    assert.equal((await request(app).get(`/api/agent/runs/${run.id}`).expect(200)).body.projectTests.patchStatus, 'verified');
  });

  it('cancels a running real project test without a late successful result', async () => {
    const manager = create({ projectConfigPath: await project(true) }); const queued = await manager.submit({ projectId: 'demo' });
    for (let i = 0; i < 100; i++) { const run = await manager.get(queued.id); if (run?.steps.some((step) => step.tool === 'project-tests' && step.status === 'running')) break; await new Promise((done) => setTimeout(done, 25)); }
    assert.ok((await manager.get(queued.id))?.steps.some((step) => step.tool === 'project-tests'));
    const cancelled = await manager.cancel(queued.id); assert.equal(cancelled.status, 'cancelled');
    const final = await manager.wait(queued.id); assert.equal(final.verdict, 'review'); assert.equal(final.projectTests, undefined);
  });
});
