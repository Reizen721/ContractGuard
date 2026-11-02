import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { AgentManager, formatAgentReportMarkdown, type AgentDecision, type AgentObservation, type AgentOptions, type AgentPlanner, type AgentRunInput, type AgentToolResult, type AgentToolRunner } from './agent/manager.js';
import { createAgentRouter } from './agent/router.js';
import { createAgentPlanner } from './agent/planner.js';
import { AGENT_TOOLS } from './agent/types.js';
import { getOasdiffStatus } from '@contractguard/oasdiff';
import './agent-v18.test.js';

const baseline = { openapi: '3.1.0', info: { title: 'Agent controlled fixture', version: '1' }, paths: { '/orders': { post: { operationId: 'createOrder', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sku', 'quantity'], properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } } } } }, responses: { '201': { description: 'Accepted' } } } } } };
const evidence = { schemaVersion: 1 as const, consumers: [{ id: 'checkout', name: 'Checkout', criticality: 'critical' as const, interactions: [{ id: 'single', method: 'POST', path: '/orders', request: { mediaType: 'application/json', body: { sku: 'DO-NOT-PERSIST-PAYLOAD-913', quantity: 1 } } }] }] };
const input = (): AgentRunInput => ({ baseline: structuredClone(baseline), candidate: structuredClone(baseline), consumerEvidence: structuredClone(evidence) });
const result = (output: unknown = [], exitCode = 0): AgentToolResult => ({ version: '1.35.0', args: [], exitCode, stdout: JSON.stringify(output), stderr: '', durationMs: 2 });
const engine = { available: true, pinnedVersion: '1.35.0', version: '1.35.0' };
const runner = (run: AgentToolRunner['run'] = async () => result()): AgentToolRunner => ({ status: async () => engine, run });
const plannerStatus = { available: true, activeProfile: 'mock', allowProfileOverride: false, providers: [{ id: 'mock', label: 'Mock', available: true, model: 'mock-model' }] };
function planner(decide: (observation: AgentObservation) => AgentDecision | Promise<AgentDecision>): AgentPlanner { return { status: () => plannerStatus, assertAvailable: () => {}, decide: async (observation) => decide(observation) }; }
const selectMandatory = (observation: AgentObservation): AgentDecision => ({ tool: observation.availableTools.includes('finish') ? 'finish' : observation.availableTools[0]!, purpose: 'Run an available bounded check' });

describe('bounded local agent', () => {
  let directory: string; let managers: AgentManager[];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-agent-test-')); managers = []; });
  afterEach(async () => { for (const manager of managers) await manager.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true }); });
  const create = (options: Partial<AgentOptions> = {}) => { const manager = new AgentManager({ dataDirectory: directory, runner: runner(), aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, ...options }); managers.push(manager); return manager; };

  it('runs five mandatory tools without any model call and passes complete clean evidence', async () => {
    const manager = create({ planner: planner(() => { throw new Error('workflow must not call planner'); }) });
    const queued = await manager.submit(input()); assert.equal(queued.status, 'queued');
    const run = await manager.wait(queued.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(run.verdict, 'pass'); assert.equal(run.plannerCalls, 0);
    assert.deepEqual(run.steps.map((step) => step.tool), ['validate-baseline', 'validate-candidate', 'breaking', 'changelog', 'native-analysis']);
    assert.equal(run.coreAnalysis?.consumerImpact?.gate, 'pass');
    assert.equal((await manager.list())[0]?.completedSteps, 5);
  });
  it('requires review when consumer evidence is absent', async () => {
    const manager = create(); const value = input(); delete value.consumerEvidence;
    const run = await manager.wait((await manager.submit(value)).id);
    assert.equal(run.verdict, 'review'); assert.match(run.limitations.join(' '), /未提交调用方证据/);
  });
  it('gates both real consumer regression and native rule findings even when upstream is clean', async () => {
    const manager = create(); const value = input();
    const candidate = structuredClone(baseline); candidate.paths['/orders'].post.requestBody.content['application/json'].schema.properties.quantity.minimum = 2; value.candidate = candidate;
    const run = await manager.wait((await manager.submit(value)).id);
    assert.equal(run.verdict, 'blocked'); assert.equal(run.coreAnalysis?.consumerImpact?.summary.regressions, 1);
    assert.ok(run.recommendations.some((item) => item.evidenceIds.some((id) => id.startsWith('CG-') || id.startsWith('CE-'))));
  });
  it('counts upstream errors from JSON even when upstream exits zero', async () => {
    const finding = { id: 'api-path-removed-without-deprecation', text: 'api path removed', level: 3, operation: 'GET', path: '/billing' };
    const manager = create({ runner: runner(async (command) => result(command === 'breaking' || command === 'changelog' ? [finding] : [])) });
    const run = await manager.wait((await manager.submit(input())).id);
    assert.equal(run.verdict, 'blocked'); assert.equal(run.upstream.breakingCount, 1); assert.equal(run.upstream.findings.length, 1); assert.equal(run.upstream.findings[0]?.id, 'OAS-0001');
  });
  it('accepts upstream findings exit one and does not misclassify it as a crash', async () => {
    const manager = create({ runner: runner(async (command) => command === 'breaking' ? result([{ id: 'risk', text: 'Risk', level: 3 }], 1) : result()) });
    const run = await manager.wait((await manager.submit(input())).id); assert.equal(run.status, 'completed'); assert.equal(run.verdict, 'blocked');
  });
  it('counts unique comparison risks independently of the legal planner tool order', async () => {
    const issue = { id: 'comparison-warning', text: 'shared warning', level: 2 };
    const validation = { id: 'validation-warning', text: 'validation warning', level: 2 };
    const mocked = runner(async (command) => result(command === 'validate' ? [validation] : [issue]));
    const workflow = create({ dataDirectory: join(directory, 'workflow'), runner: mocked });
    const llm = create({ dataDirectory: join(directory, 'llm'), runner: mocked, planner: planner((context) => context.availableTools.includes('changelog') ? { tool: 'changelog', purpose: 'Inspect changelog first' } : selectMandatory(context)) });
    const left = await workflow.wait((await workflow.submit(input())).id); const right = await llm.wait((await llm.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(left.upstream.warningCount, 3); assert.equal(right.upstream.warningCount, 3);
    assert.equal(left.upstream.findings.length, right.upstream.findings.length); assert.equal(right.verdict, 'review');
  });
  it('validates both sides, blocks an invalid spec, and skips comparison', async () => {
    const calls: string[] = [];
    const manager = create({ runner: runner(async (command, _inputs, options) => { calls.push(`${command}:${options.side}`); return options.side === 'baseline' ? result([{ id: 'path-must-start-with-slash', text: 'invalid path', level: 3 }], 1) : result(); }) });
    const run = await manager.wait((await manager.submit(input())).id);
    assert.equal(run.status, 'completed'); assert.equal(run.verdict, 'blocked'); assert.deepEqual(calls, ['validate:baseline', 'validate:candidate']); assert.equal(run.coreAnalysis, undefined);
  });
  it('treats upstream load failure as invalid input without retaining stderr', async () => {
    const manager = create({ runner: runner(async (_command, _inputs, options) => options.side === 'candidate' ? { ...result([], 102), stderr: 'SECRET SOURCE CONTENT' } : result()) });
    const run = await manager.wait((await manager.submit(input())).id);
    assert.equal(run.status, 'completed'); assert.equal(run.verdict, 'blocked'); assert.doesNotMatch(JSON.stringify(run), /SECRET SOURCE/);
  });
  it('does not fall back silently when the engine is missing', async () => {
    const manager = create({ runner: { status: async () => ({ available: false, pinnedVersion: '1.35.0' }), run: async () => { throw new Error('must not run'); } } });
    const run = await manager.wait((await manager.submit(input())).id);
    assert.equal(run.status, 'failed'); assert.equal(run.error?.code, 'AGENT_ENGINE_UNAVAILABLE'); assert.equal(run.coreAnalysis, undefined); assert.equal(run.verdict, 'review');
  });
  it('keeps 3.2 upstream results and marks native consumer analysis unavailable', async () => {
    const manager = create(); const value = input(); value.baseline = { ...baseline, openapi: '3.2.0' }; value.candidate = value.baseline;
    const run = await manager.wait((await manager.submit(value)).id);
    assert.equal(run.status, 'completed'); assert.equal(run.verdict, 'review'); assert.match(run.nativeUnavailable!, /UNSUPPORTED_SPEC_VERSION/);
  });
  it('lets the model select optional tools while retaining mandatory checks and deterministic verdict', async () => {
    const observations: AgentObservation[] = [];
    const manager = create({ planner: planner((context) => { observations.push(context); if (context.availableTools.includes('diff')) return { tool: 'diff', purpose: '补充结构比较' }; if (context.availableTools.includes('summary')) return { tool: 'summary', purpose: '补充统计' }; return selectMandatory(context); }) });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'completed'); assert.equal(run.steps.length, 7); assert.equal(run.plannerCalls, 8); assert.equal(run.verdict, 'pass');
    assert.ok(observations.at(-1)!.evidence.some((item) => item.kind.startsWith('consumer:')));
    assert.doesNotMatch(JSON.stringify(observations), /DO-NOT-PERSIST-PAYLOAD|baselineBody|candidateBody/);
  });
  for (const invalid of ['finish', 'shell', 'https://attacker.invalid', 'rm -rf']) it(`rejects unavailable planner action: ${invalid}`, async () => {
    const manager = create({ planner: planner(() => ({ tool: invalid as AgentDecision['tool'], purpose: 'try to bypass policy' })) });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'failed'); assert.equal(run.error?.code, 'AGENT_INVALID_DECISION'); assert.equal(run.steps.length, 0);
  });
  it('rejects repeated model tools instead of wasting the action budget', async () => {
    const manager = create({ planner: planner(() => ({ tool: 'validate-baseline', purpose: 'validate baseline' })) });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'failed'); assert.equal(run.steps.length, 1); assert.equal(run.error?.code, 'AGENT_INVALID_DECISION');
  });
  it('rejects invented evidence citations in migration advice', async () => {
    const manager = create({ planner: planner((context) => context.availableTools.includes('finish') ? { tool: 'finish', purpose: 'summarize', recommendations: [{ title: 'Invented', actions: ['do something'], evidenceIds: ['FAKE-9999'] }] } : selectMandatory(context)) });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'failed'); assert.equal(run.error?.code, 'AGENT_INVALID_EVIDENCE'); assert.equal(run.recommendations.length, 0);
  });
  it('saves validated model advice while keeping deterministic verdict separate', async () => {
    const manager = create({ planner: planner((context) => context.availableTools.includes('finish') ? { tool: 'finish', purpose: 'summarize', summary: 'Submitted checks completed.', recommendations: [{ title: 'Retain evidence', actions: ['Re-run when consumers change.'], evidenceIds: [context.knownEvidenceIds[0]!] }] } : selectMandatory(context)) });
    const value = input(); delete value.consumerEvidence;
    const run = await manager.wait((await manager.submit({ ...value, mode: 'llm' })).id);
    assert.equal(run.verdict, 'review'); assert.equal(run.recommendations[0]?.title, 'Retain evidence');
  });
  it('cancels a running process and ignores its late result', async () => {
    let release!: (value: AgentToolResult) => void; let entered!: () => void;
    const started = new Promise<void>((accept) => { entered = accept; });
    const manager = create({ runner: runner(async () => { entered(); return new Promise((accept) => { release = accept; }); }) });
    const queued = await manager.submit(input()); await started;
    const cancelled = await manager.cancel(queued.id); assert.equal(cancelled.status, 'cancelled');
    release(result([{ id: 'late', text: 'late output', level: 3 }]));
    await new Promise((accept) => setImmediate(accept));
    const saved = await manager.get(queued.id); assert.equal(saved?.status, 'cancelled'); assert.equal(saved?.upstream.findings.length, 0);
    assert.equal((await manager.wait(queued.id)).status, 'cancelled');
  });
  it('bounds the queue and lets a queued task be cancelled independently', async () => {
    let entered!: () => void; const started = new Promise<void>((accept) => { entered = accept; });
    const manager = create({ maxQueued: 2, runner: runner(async () => { entered(); return new Promise(() => {}); }) });
    const first = await manager.submit(input()); await started;
    const second = await manager.submit(input()); await assert.rejects(manager.submit(input()), { code: 'AGENT_QUEUE_FULL' });
    assert.equal((await manager.cancel(second.id)).steps.length, 0); assert.equal((await manager.cancel(first.id)).status, 'cancelled');
  });
  it('recovers unfinished durable records as interrupted without resuming inputs', async () => {
    const manager = create(); const run = await manager.wait((await manager.submit(input())).id); await manager.close();
    run.status = 'running'; run.steps[0]!.status = 'running';
    await writeFile(join(directory, run.id + '.json'), JSON.stringify(run));
    const reopened = create({ runner: runner(async () => { throw new Error('restart must not run'); }) });
    const recovered = await reopened.get(run.id); assert.equal(recovered?.status, 'interrupted'); assert.equal(recovered?.verdict, 'review'); assert.equal(recovered?.steps[0]?.status, 'failed');
  });
  it('does not publish completion through get/list/wait until the final atomic write finishes', async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((accept) => { entered = accept; }); const hold = new Promise<void>((accept) => { release = accept; });
    class SlowFinalManager extends AgentManager {
      protected override async writeRecord(id: string, contents: string): Promise<void> {
        if (JSON.parse(contents).status === 'completed') { entered(); await hold; }
        await super.writeRecord(id, contents);
      }
    }
    const manager = new SlowFinalManager({ dataDirectory: directory, runner: runner() }); managers.push(manager);
    const queued = await manager.submit(input()); await started;
    let readsFinished = 0;
    const reads = Promise.all([manager.get(queued.id), manager.list(), manager.wait(queued.id)]).then((values) => { readsFinished++; return values; });
    await new Promise((accept) => setImmediate(accept)); assert.equal(readsFinished, 0);
    assert.equal(JSON.parse(await readFile(join(directory, queued.id + '.json'), 'utf8')).status, 'running');
    release(); const [run] = await reads;
    assert.equal(run?.status, 'completed'); assert.deepEqual(JSON.parse(await readFile(join(directory, queued.id + '.json'), 'utf8')), run);
  });
  it('records failed final persistence as failure instead of announcing a completed task', async () => {
    class FailingFinalManager extends AgentManager {
      protected override async writeRecord(id: string, contents: string): Promise<void> {
        if (JSON.parse(contents).status === 'completed') throw new Error('simulated full disk');
        await super.writeRecord(id, contents);
      }
    }
    const manager = new FailingFinalManager({ dataDirectory: directory, runner: runner() }); managers.push(manager);
    const run = await manager.wait((await manager.submit(input())).id);
    assert.equal(run.status, 'failed'); assert.equal(run.error?.code, 'AGENT_PERSIST_FAILED');
    assert.deepEqual(JSON.parse(await readFile(join(directory, run.id + '.json'), 'utf8')), run);
  });
  it('bounds oversized native metadata and still persists a truthful terminal record', async () => {
    const manager = create(); const value = input();
    (value.baseline as typeof baseline).info.title = 'x'.repeat(2_200_000);
    (value.candidate as typeof baseline).info.title = 'x'.repeat(2_200_000);
    const run = await manager.wait((await manager.submit(value)).id);
    assert.equal(run.status, 'completed'); assert.equal(run.verdict, 'review'); assert.equal(run.coreAnalysis?.source.old.title?.length, 1000);
    assert.equal(run.upstream.truncated, true);
    const saved = await readFile(join(directory, run.id + '.json'), 'utf8'); assert.ok(Buffer.byteLength(saved) < 4 * 1024 * 1024); assert.deepEqual(JSON.parse(saved), run);
  });
  it('stores no raw contracts, payloads or before/after fragments and renders portable reports', async () => {
    const manager = create(); const value = input(); (value.baseline as Record<string, unknown>)['x-private-secret'] = 'DO-NOT-PERSIST-CONTRACT-234';
    const run = await manager.wait((await manager.submit(value)).id);
    for (const file of await readdir(directory)) assert.doesNotMatch(await readFile(join(directory, file), 'utf8'), /DO-NOT-PERSIST-PAYLOAD|DO-NOT-PERSIST-CONTRACT|"baselineBody"|"candidateBody"/);
    assert.match(formatAgentReportMarkdown(run), /STEP-01/); assert.doesNotMatch(formatAgentReportMarkdown(run), /DO-NOT-PERSIST/);
  });
  it('redacts private enum literals from both upstream prose and native diagnostics before model/storage', async () => {
    const marker = 'private-value-9c7f'; const observations: AgentObservation[] = [];
    const value = input();
    (value.baseline as typeof baseline).paths['/orders'].post.requestBody.content['application/json'].schema.properties.sku = { type: 'string', enum: ['ordinary', marker] } as { type: string };
    (value.candidate as typeof baseline).paths['/orders'].post.requestBody.content['application/json'].schema.properties.sku = { type: 'string', enum: ['ordinary'] } as { type: string };
    value.consumerEvidence!.consumers[0]!.interactions[0]!.request!.body = { sku: 'ordinary', quantity: 1 };
    const manager = create({ runner: runner(async (command) => result(command === 'breaking' || command === 'changelog' ? [{ id: 'request-enum-value-removed', text: 'request enum removed `' + marker + '`', level: 3, operation: 'POST', path: '/orders' }] : [])), planner: planner((context) => { observations.push(context); return selectMandatory(context); }) });
    const run = await manager.wait((await manager.submit({ ...value, mode: 'llm' })).id);
    assert.equal(run.verdict, 'blocked'); assert.ok(run.coreAnalysis!.changes.length > 0); assert.ok(run.upstream.findings.length > 0);
    for (const output of [JSON.stringify(run), JSON.stringify(observations), await readFile(join(directory, run.id + '.json'), 'utf8'), formatAgentReportMarkdown(run)]) assert.ok(!output.includes(marker));
  });
  it('keeps real pinned-engine enum diagnostics private in stored reports and planner observations', async (context) => {
    if (!(await getOasdiffStatus()).available) { context.skip('Pinned oasdiff is not installed; wrapper integration suite covers installation.'); return; }
    const marker = 'private-value-real-9c7f'; const observations: AgentObservation[] = []; const value = input();
    (value.baseline as typeof baseline).paths['/orders'].post.requestBody.content['application/json'].schema.properties.sku = { type: 'string', enum: ['ordinary', marker] } as { type: string };
    (value.candidate as typeof baseline).paths['/orders'].post.requestBody.content['application/json'].schema.properties.sku = { type: 'string', enum: ['ordinary'] } as { type: string };
    value.consumerEvidence!.consumers[0]!.interactions[0]!.request!.body = { sku: 'ordinary', quantity: 1 };
    const manager = new AgentManager({ dataDirectory: directory, planner: planner((observation) => { observations.push(observation); return selectMandatory(observation); }) }); managers.push(manager);
    const run = await manager.wait((await manager.submit({ ...value, mode: 'llm' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(run.verdict, 'blocked'); assert.ok(run.upstream.breakingCount > 0);
    assert.ok(!JSON.stringify(observations).includes(marker)); assert.ok(!(await readFile(join(directory, run.id + '.json'), 'utf8')).includes(marker));
  });
  it('rejects arbitrary tool inputs, unexpected properties, cycles and oversized content before storing', async () => {
    const manager = create(); const cyclic = input(); (cyclic as unknown as Record<string, unknown>).baseline = cyclic;
    for (const value of [{ ...input(), command: 'shell' }, { ...input(), providerId: 'mock' }, { ...input(), baseline: 'x'.repeat(5 * 1024 * 1024 + 1) }, cyclic]) await assert.rejects(manager.submit(value), { code: 'INVALID_AGENT_INPUT' });
    assert.deepEqual(await manager.list(), []);
  });
  it('fails closed on malformed upstream output without echoing stderr or raw output', async () => {
    const manager = create({ runner: runner(async () => ({ ...result(), stdout: 'SECRET MALFORMED', stderr: 'SECRET STDERR' })) });
    const run = await manager.wait((await manager.submit(input())).id); assert.equal(run.error?.code, 'AGENT_TOOL_OUTPUT'); assert.doesNotMatch(JSON.stringify(run), /SECRET/);
  });
  it('exposes asynchronous routes, history, cancellation and downloadable reports', async () => {
    const app = express(); app.use(express.json()); app.use('/api/agent', createAgentRouter({ dataDirectory: directory, runner: runner(), aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, onManager: (manager) => managers.push(manager) }));
    const response = await request(app).post('/api/agent/runs').send(input()); assert.equal(response.status, 202);
    const run = await managers[0]!.wait(response.body.id);
    assert.equal((await request(app).get('/api/agent/status')).body.workflowAvailable, true);
    assert.equal((await request(app).get('/api/agent/runs')).body.runs.length, 1);
    assert.equal((await request(app).get('/api/agent/runs/' + run.id)).body.status, 'completed');
    assert.equal((await request(app).get(`/api/agent/runs/${run.id}/report?format=markdown`)).status, 200);
    assert.equal((await request(app).get(`/api/agent/runs/${run.id}/report?format=html`)).status, 400);
    assert.equal((await request(app).get('/api/agent/runs/missing')).status, 404);
    assert.equal((await request(app).post('/api/agent/runs').send({ ...input(), tool: 'shell' })).status, 400);
  });
  it('uses the configured cloud adapter only in llm mode, with bounded JSON decisions and no payloads', async () => {
    const bodies: string[] = []; const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url)); bodies.push(String(init?.body)); assert.equal(init?.redirect, 'error');
      const payload = JSON.parse(String(init?.body)); const context = JSON.parse(payload.messages[1].content) as AgentObservation;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(selectMandatory(context)) } }] }), { status: 200 });
    }) as typeof fetch;
    const manager = create({ aiConfig: { enabled: true, apiKey: 'sk-test-secret', baseUrl: 'https://api.deepseek.com', model: 'mock-model' }, aiFetch: fetcher });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error)); assert.equal(bodies.length, 6); assert.ok(urls.every((url) => url === 'https://api.deepseek.com/chat/completions'));
    assert.doesNotMatch(bodies.join(''), /DO-NOT-PERSIST|sk-test-secret|baselineBody|candidateBody/);
    assert.doesNotMatch(JSON.stringify(run), /sk-test-secret/);
  });
  it('describes every available tool and distinguishes contract validation and statistics from task completion', async () => {
    const prompts: string[] = [];
    const configured = createAgentPlanner({ dataDirectory: directory, aiEnvironment: {}, aiConfig: { enabled: true, apiKey: 'test-only' }, aiFetch: (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      prompts.push(payload.messages[0].content);
      const context = JSON.parse(payload.messages[1].content) as AgentObservation;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(selectMandatory(context)) } }] }));
    }) as typeof fetch });
    const observation: AgentObservation = { goal: 'Review the migration', availableTools: [...AGENT_TOOLS], completedTools: [], steps: [], knownEvidenceIds: [], evidence: [], limitations: [], deterministicVerdict: null, counts: { upstreamBreaking: 0, upstreamWarnings: 0, validationErrors: 0, nativeBreaking: null, consumerRegressions: null } };
    await configured.decide(observation, { signal: new AbortController().signal });
    await configured.decide({ ...observation, availableTools: ['summary', 'diff', 'finish'] }, { signal: new AbortController().signal });
    const descriptions = (prompt: string) => Object.fromEntries(prompt.split('\nTool semantics:\n')[1]!.split('\nJSON schema:')[0]!.split('\n').map((line) => { const split = line.indexOf(': '); return [line.slice(0, split), line.slice(split + 2)]; }));
    const initial = descriptions(prompts[0]!); const final = descriptions(prompts[1]!);
    assert.deepEqual(Object.keys(initial), [...AGENT_TOOLS]);
    assert.deepEqual(Object.keys(final), ['summary', 'diff', 'finish']);
    assert.match(initial['validate-baseline']!, /only the baseline OpenAPI document.*does not apply or verify migration patches, replay callers, or run project tests/i);
    assert.match(initial['validate-candidate']!, /only the candidate OpenAPI document.*not a migration patch.*does not apply or verify patches, replay callers, or run project tests/i);
    assert.match(initial.breaking!, /oasdiff backward-compatibility rules/);
    assert.match(initial.changelog!, /contract change diagnostics, including breaking and non-breaking changes/);
    assert.match(initial['native-analysis']!, /native contract rules.*consumer request\/response evidence.*does not execute caller source or project tests/);
    assert.match(initial['caller-analysis']!, /callsites.*replay supplied scenarios.*verify proposed field-migration patches with the bounded interpreter/);
    assert.match(initial['project-tests']!, /operator-registered trusted project test configuration in independent baseline, candidate, and eligible patched copies/);
    assert.match(final.summary!, /oasdiff summary for OpenAPI structural change statistics.*not a whole-task summary or finish action.*does not combine contract, caller, and project-test evidence/);
    assert.match(final.diff!, /oasdiff diff for OpenAPI structural differences.*only structural statistics and a result fingerprint are retained/);
    assert.match(final.finish!, /Finish the task and summarize the collected contract, caller, and project-test evidence.*runs no further checks.*cannot change the deterministic verdict/);
  });
  it('rejects model profile override and bounded response failures without exposing credentials', async () => {
    const configured = createAgentPlanner({ dataDirectory: directory, aiEnvironment: {}, aiConfig: { enabled: true, apiKey: 'private-key', maxResponseBytes: 1024 }, aiFetch: (async () => new Response('private-key'.repeat(1000))) as typeof fetch });
    assert.throws(() => configured.assertAvailable('evil-profile'), { code: 'AGENT_PROFILE_OVERRIDE_DISABLED' });
    const manager = create({ planner: configured }); const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.error?.code, 'AGENT_PLANNER_OUTPUT_LIMIT'); assert.doesNotMatch(JSON.stringify(run), /private-key/);
  });
  it('repairs one rejected cloud decision without executing it and counts the extra request', async () => {
    let calls = 0;
    const manager = create({ aiConfig: { enabled: true, apiKey: 'test-only' }, aiFetch: (async (_url, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      const context = JSON.parse(payload.messages[1].content) as AgentObservation;
      const decision = calls === 1 ? { tool: 'shell', purpose: 'invalid' } : { ...selectMandatory(context), summary: '' };
      if (calls === 2) assert.match(payload.messages[2].content, /previous response was rejected/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }));
    }) as typeof fetch });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.equal(run.steps.length, 5); assert.equal(run.plannerCalls, 7); assert.equal(calls, 7);
    assert.ok(run.steps.every(step => step.tool !== ('shell' as unknown)));
  });
  it('stops after one failed repair without executing invalid tools', async () => {
    let calls = 0;
    const manager = create({ aiConfig: { enabled: true, apiKey: 'test-only' }, aiFetch: (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool: 'shell', purpose: 'invalid' }) } }] }));
    }) as typeof fetch });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.status, 'failed'); assert.equal(run.steps.length, 0); assert.equal(calls, 2); assert.equal(run.plannerCalls, 2);
  });
  it('does not retry an authentication failure', async () => {
    let calls = 0;
    const manager = create({ aiConfig: { enabled: true, apiKey: 'test-only' }, aiFetch: (async () => { calls++; return new Response('not retained', { status: 401 }); }) as typeof fetch });
    const run = await manager.wait((await manager.submit({ ...input(), mode: 'llm' })).id);
    assert.equal(run.error?.code, 'AGENT_PLANNER_HTTP'); assert.equal(calls, 1);
  });
});
