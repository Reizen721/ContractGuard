import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { analyzeRelease, ContractGuardError, ENGINE_VERSION, fingerprintObject, fingerprintOpenApiInput, getRule } from '@contractguard/core';
import { getOasdiffStatus, runPreparedOasdiff } from '@contractguard/oasdiff';
import { ProjectRegistry, runProjectTests, type PreparedProject, type ProjectSummary } from '@contractguard/project';
import type { CallerImpactReport } from '@contractguard/caller';
import { CallerReviewExecutor } from '../caller/executor.js';
import { CallerReviewStore } from '../caller/store.js';
import { AgentError, isRecord, validateAgentInput, validateProjectSelection } from './input.js';
import { createAgentPlanner, validateDecision } from './planner.js';
import { AGENT_TOOLS, type AgentDecision, type AgentFinding, type AgentObservation, type AgentOptions, type AgentPlanner, type AgentRecommendation, type AgentRun, type AgentRunInput, type AgentRunSummary, type AgentStatus, type AgentStep, type AgentTool, type AgentToolResult, type AgentToolRunner } from './types.js';

export type * from './types.js';
export { AgentError } from './input.js';
export { formatAgentReportMarkdown } from './report.js';
const MAX_DURATION = 240_000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS = 200;
const MAX_RUNS = 500;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const mandatory: AgentTool[] = ['validate-baseline', 'validate-candidate', 'breaking', 'changelog', 'native-analysis'];
const purposes: Record<AgentTool, string> = {
  'validate-baseline': '校验基线契约是否有效', 'validate-candidate': '校验候选契约是否有效', breaking: '运行上游兼容性规则', changelog: '汇总上游完整变更', 'native-analysis': '检查原生规则与提交的调用方证据', summary: '检查契约的结构变更统计', diff: '补充结构差异证据',
  'caller-analysis': '定位调用方源码并验证候选补丁', 'project-tests': '在独立副本运行项目已有测试',
};
const requiredTools = (run: AgentRun): AgentTool[] => run.requiredTools ?? mandatory;
function projectEvidence(run: AgentRun): AgentObservation['evidence'] {
  if (!run.projectTests) return [];
  return (['baseline', 'candidate', 'patched'] as const).flatMap((phase) => {
    const result = run.projectTests![phase];
    return result ? [{ id: `PROJECT-${phase.toUpperCase()}`, kind: `project-test:${result.status}`, summary: `${phase}: ${result.tests.passed} passed, ${result.tests.failed} failed, ${result.tests.skipped} skipped; exit ${result.exitCode ?? 'unknown'}.` }] : [];
  });
}
const final = (run: AgentRun) => !['queued', 'running'].includes(run.status);
const stamp = () => new Date().toISOString();
const cleanText = (value: unknown, maximum = 1200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum) : '';
function boundedAnalysis<T>(analysis: T): { value: T; truncated: boolean } {
  let truncated = false;
  const bound = (value: unknown): unknown => {
    if (typeof value === 'string') { if (value.length > 1000) truncated = true; return cleanText(value, 1000); }
    if (Array.isArray(value)) { if (value.length > 200) truncated = true; return value.slice(0, 200).map(bound); }
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bound(child)]));
    return value;
  };
  return { value: bound(analysis) as T, truncated };
}
function aborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled or exceeded its time budget.'));
  return new Promise((accept, reject) => {
    const abort = () => reject(new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled or exceeded its time budget.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(accept, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}
function knownIds(run: AgentRun): string[] {
  return [...new Set([...run.steps.filter((step) => step.status === 'completed').map((step) => step.id), ...(run.callerReview?.checks.map((check) => check.id) ?? []), ...(run.callerReview?.patches.map((patch) => patch.id) ?? []), ...projectEvidence(run).map((item) => item.id), ...run.upstream.findings.map((finding) => finding.id), ...(run.coreAnalysis?.changes.map((change) => change.id) ?? []), ...(run.coreAnalysis?.consumerImpact?.consumers.flatMap((consumer) => consumer.checks.map((check) => check.id)) ?? [])])].slice(0, 600);
}
function availableTools(run: AgentRun): Array<AgentTool | 'finish'> {
  const done = new Set(run.steps.filter((step) => step.status === 'completed').map((step) => step.tool));
  const validation = mandatory.slice(0, 2).filter((tool) => !done.has(tool));
  if (validation.length) return validation;
  if (!run.upstream.baselineValid || !run.upstream.candidateValid) return ['finish'];
  const required = requiredTools(run);
  return [...AGENT_TOOLS.filter((tool) => !done.has(tool) && (!['caller-analysis', 'project-tests'].includes(tool) || required.includes(tool)) && (tool !== 'project-tests' || !required.includes('caller-analysis') || done.has('caller-analysis'))), ...(required.every((tool) => done.has(tool)) ? ['finish' as const] : [])];
}
function verdict(run: AgentRun): AgentRun['verdict'] {
  const core = run.coreAnalysis;
  if (run.upstream.validationErrors > 0 || run.upstream.breakingCount > 0 || (core?.summary.breaking ?? 0) > 0 || core?.consumerImpact?.gate === 'blocked' || run.callerReview?.gate === 'blocked' || run.projectTests?.status === 'regression') return 'blocked';
  const hasEvidence = core?.consumerImpact?.gate === 'pass' || run.callerReview?.gate === 'pass' || run.projectTests?.status === 'pass';
  if (run.upstream.baselineValid !== true || run.upstream.candidateValid !== true || !requiredTools(run).every((tool) => run.steps.some((step) => step.tool === tool && step.status === 'completed')) || run.upstream.warningCount > 0 || run.upstream.truncated || !core || core.summary.potentiallyBreaking > 0 || core.coverage?.status !== 'complete' || !hasEvidence || core.consumerImpact !== undefined && core.consumerImpact.gate !== 'pass' || run.callerReview !== undefined && run.callerReview.gate !== 'pass' || run.projectTests !== undefined && run.projectTests.status !== 'pass') return 'review';
  return 'pass';
}
function observation(run: AgentRun): AgentObservation {
  const evidence: AgentObservation['evidence'] = [
    ...(run.callerReview?.checks.map((check) => ({ id: check.id, kind: `caller:${check.status}`, summary: `Caller replay status: ${check.status}.`, location: cleanText(`${check.file}:${check.exportName}`, 300) })) ?? []),
    ...(run.callerReview?.patches.map((patch) => ({ id: patch.id, kind: `caller-patch:${patch.status}`, summary: `Candidate patch bounded replay status: ${patch.status}. This does not clear the original release gate.`, location: cleanText(patch.file, 240) })) ?? []),
    ...projectEvidence(run),
    ...run.upstream.findings.slice(0, 50).map((finding) => ({ id: finding.id, kind: `oasdiff:${finding.severity}`, summary: cleanText(`${finding.ruleId}: ${finding.message}`, 450), ...(finding.path ? { location: cleanText(`${finding.operation ?? ''} ${finding.path}`, 300) } : {}) })),
    ...(run.coreAnalysis?.changes.slice(0, 40).map((change) => ({ id: change.id, kind: `native:${change.severity}`, summary: cleanText(`${change.ruleId}: ${change.message}`, 450), location: cleanText(change.location, 300) })) ?? []),
    ...(run.coreAnalysis?.consumerImpact?.consumers.flatMap((consumer) => consumer.checks).slice(0, 40).map((check) => ({ id: check.id, kind: `consumer:${check.status}`, summary: cleanText(`${check.kind}: ${check.note}`, 450), location: cleanText(`${check.method} ${check.path}`, 300), relatedEvidenceIds: check.relatedChangeIds.slice(0, 8) })) ?? []),
  ];
  return { goal: run.goal, availableTools: availableTools(run), completedTools: run.steps.filter((step) => step.status === 'completed').map((step) => step.tool), steps: run.steps.map(({ id, tool, status, summary, evidenceIds }) => ({ id, tool, status, summary, evidenceIds })), knownEvidenceIds: knownIds(run), evidence, limitations: run.limitations, deterministicVerdict: verdict(run), counts: { upstreamBreaking: run.upstream.breakingCount, upstreamWarnings: run.upstream.warningCount, validationErrors: run.upstream.validationErrors, nativeBreaking: run.coreAnalysis?.summary.breaking ?? null, consumerRegressions: run.coreAnalysis?.consumerImpact?.summary.regressions ?? null, callerRegressions: run.callerReview?.summary.regressions ?? null, verifiedCallerPatches: run.callerReview?.summary.verifiedPatches ?? null, projectTestStatus: run.projectTests?.status ?? null } };
}
function recommendations(run: AgentRun): AgentRecommendation[] {
  const result: AgentRecommendation[] = [];
  for (const check of run.callerReview?.checks.filter((item) => item.status !== 'pass') ?? []) result.push({ title: `调用方 ${check.file} 的源码迁移`, actions: ['打开关联的调用方审查记录，核对源码位置、场景及未覆盖范围。', '候选补丁只在副本验证；检查项目真实测试结果后再决定是否采用。'], evidenceIds: [check.id] });
  if (run.projectTests) result.push({ title: '项目已有测试复验', actions: [`原始代码测试结论为 ${run.projectTests.status}；候选补丁复验为 ${run.projectTests.patchStatus}。`, '仅执行注册项目选定的测试文件；保留输入快照与原始契约风险，并复核未覆盖场景。'], evidenceIds: projectEvidence(run).map((item) => item.id) });
  for (const task of run.coreAnalysis?.consumerImpact?.migrationTasks ?? []) result.push({ title: `调用方 ${task.consumerId} 的迁移检查`, actions: [task.action, task.verification], evidenceIds: [...task.checkIds, ...task.changeIds].filter((id) => knownIds(run).includes(id)).slice(0, 12) });
  for (const finding of run.upstream.findings.filter((item) => item.severity !== 'info').slice(0, 6)) result.push({ title: finding.ruleId, actions: [finding.message, '确认受影响的调用方，保留兼容行为或安排版本迁移；补充变更前后调用样例后重新检查。'], evidenceIds: [finding.id] });
  for (const change of run.coreAnalysis?.changes.filter((item) => item.severity === 'breaking' || item.severity === 'potentially-breaking').slice(0, 6) ?? []) result.push({ title: change.ruleId, actions: [change.recommendation ?? '检查此契约变化，补齐调用方回归样例并协调迁移。'], evidenceIds: [change.id] });
  if (result.length === 0 && run.steps.length) result.push({ title: run.verdict === 'pass' ? '保留本次验证证据' : '补齐验证范围', actions: [run.verdict === 'pass' ? '将本次报告与契约版本一同归档；生产上线仍需按团队发布流程验证。' : '补充缺失或不确定的调用方样例与契约范围，再运行检查。'], evidenceIds: [run.steps.find((step) => step.status === 'completed')?.id ?? run.steps[0]!.id] });
  return result.filter((item) => item.evidenceIds.length > 0).slice(0, 12);
}

/** One in-process queue. Store directory belongs to one API/CLI owner at a time. */
export class AgentManager {
  private readonly records = new Map<string, AgentRun>();
  private readonly inputs = new Map<string, AgentRunInput>();
  private readonly projects = new Map<string, PreparedProject>();
  private readonly callerReports = new Map<string, CallerImpactReport>();
  private readonly projectRegistry: ProjectRegistry;
  private readonly callerExecutor = new CallerReviewExecutor();
  private readonly callerStore: CallerReviewStore;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly riskLedger = new Map<string, { validationErrors: Partial<Record<'baseline' | 'candidate', number>>; validationWarnings: Partial<Record<'baseline' | 'candidate', number>>; errors: Set<string>; warnings: Set<string> }>();
  private readonly waiters = new Map<string, Array<(run: AgentRun) => void>>();
  private readonly runner: AgentToolRunner;
  private readonly directory: string;
  private readonly maximumQueue: number;
  private readyPromise?: Promise<void>;
  private saveTail: Promise<void> = Promise.resolve();
  private pumping = false;
  private closed = false;
  private plannerInstance?: AgentPlanner;
  constructor(private readonly options: AgentOptions) {
    this.directory = resolve(options.dataDirectory);
    this.projectRegistry = new ProjectRegistry(options.projectConfigPath ?? (options.aiEnvironment ?? process.env).CONTRACTGUARD_PROJECT_CONFIG);
    this.callerStore = new CallerReviewStore(options.callerDataDirectory ?? join(this.directory, '..', 'caller-reviews'));
    this.maximumQueue = options.maxQueued ?? 20;
    if (!Number.isInteger(this.maximumQueue) || this.maximumQueue < 1 || this.maximumQueue > 20) throw new AgentError(400, 'INVALID_AGENT_QUEUE', 'maxQueued must be between 1 and 20.');
    const executable = options.oasdiffPath === undefined ? {} : { executablePath: options.oasdiffPath };
    this.runner = options.runner ?? { status: () => getOasdiffStatus(executable), run: (command, inputs, runOptions) => runPreparedOasdiff(command, inputs, { ...runOptions, ...executable, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 }) };
  }
  private planner(): AgentPlanner { return this.plannerInstance ??= this.options.planner ?? createAgentPlanner(this.options); }
  private ready(): Promise<void> { return this.readyPromise ??= this.initialize(); }
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5)));
    if (files.length > MAX_RUNS) throw new AgentError(507, 'AGENT_STORE_LIMIT', 'The agent history contains too many records; archive older reports before continuing.');
    for (const name of files) {
      let run: AgentRun;
      try {
        const path = join(this.directory, name);
        if ((await stat(path)).size > MAX_RECORD_BYTES) continue;
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.id !== name.slice(0, -5) || !Array.isArray(parsed.steps) || !isRecord(parsed.upstream) || !Array.isArray(parsed.recommendations) || !Array.isArray(parsed.limitations) || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(parsed.status))) continue;
        run = parsed as unknown as AgentRun;
      } catch { continue; }
      this.records.set(run.id, run);
      if (!final(run)) {
        run.status = 'interrupted'; run.verdict = 'review'; run.finishedAt = stamp(); run.summary = '服务重启中断了任务。原始输入未保存，请重新提交。';
        run.error = { code: 'AGENT_RESTARTED', message: 'Task interrupted by service restart; raw inputs were intentionally not persisted.' };
        for (const step of run.steps) if (step.status === 'running') { step.status = 'failed'; step.finishedAt = stamp(); step.summary = '服务重启，检查未完成。'; }
        await this.save(run);
      }
    }
  }
  private save(run: AgentRun): Promise<void> {
    run.updatedAt = stamp();
    const contents = JSON.stringify(run, null, 2);
    if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) return Promise.reject(new AgentError(507, 'AGENT_REPORT_LIMIT', 'Agent report exceeds its bounded storage limit.'));
    const write = this.saveTail.catch(() => {}).then(() => this.writeRecord(run.id, contents)).catch(() => { throw new AgentError(507, 'AGENT_PERSIST_FAILED', 'Task progress could not be saved.'); });
    this.saveTail = write; return write;
  }
  /** Overrideable storage boundary keeps slow/error durability tests deterministic. */
  protected async writeRecord(id: string, contents: string): Promise<void> {
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, join(this.directory, `${id}.json`)); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  private async flush(): Promise<void> {
    while (true) {
      const tail = this.saveTail;
      try { await tail; } catch (error) { if (tail === this.saveTail) throw error; }
      if (tail === this.saveTail) return;
    }
  }
  async status(): Promise<AgentStatus> {
    const [engine, planner] = await Promise.all([this.runner.status(), Promise.resolve().then(() => this.planner().status())]);
    return { schemaVersion: 1, workflowAvailable: engine.available, llmAvailable: engine.available && planner.available, engine, planner, limits: { maxQueued: this.maximumQueue, maxSteps: AGENT_TOOLS.length, concurrency: 1, maxDurationMs: MAX_DURATION } };
  }
  async listProjects(): Promise<ProjectSummary[]> { return this.projectRegistry.list(); }
  async submit(value: AgentRunInput | unknown): Promise<AgentRun> {
    const selection = validateProjectSelection(value);
    const prepared = selection ? await this.projectRegistry.prepare(selection.projectId) : undefined;
    const input = prepared ? validateAgentInput({ baseline: prepared.baseline, candidate: prepared.candidate, baselineName: `${prepared.metadata.label} baseline`, candidateName: `${prepared.metadata.label} candidate`, ...(selection!.mode === undefined ? {} : { mode: selection!.mode }), ...(selection!.goal === undefined ? {} : { goal: selection!.goal }), ...(selection!.providerId === undefined ? {} : { providerId: selection!.providerId }), ...(prepared.caller ? { caller: { files: prepared.caller.files, scenarios: prepared.caller.scenarios, ...(prepared.caller.fieldRenames ? { fieldRenames: prepared.caller.fieldRenames } : {}) } } : {}) }) : validateAgentInput(value);
    await this.ready();
    if (this.closed) throw new AgentError(503, 'AGENT_CLOSED', 'Agent manager is shutting down.');
    if (this.records.size >= MAX_RUNS) throw new AgentError(507, 'AGENT_STORE_LIMIT', 'Agent history is full; archive old reports before continuing.');
    if ([...this.records.values()].filter((run) => !final(run)).length >= this.maximumQueue) throw new AgentError(429, 'AGENT_QUEUE_FULL', 'Agent queue is full. Wait for a task to finish.');
    if (input.mode === 'llm') this.planner().assertAvailable(input.providerId);
    const now = stamp();
    const run: AgentRun = { schemaVersion: 1, id: randomUUID(), mode: input.mode ?? 'workflow', status: 'queued', createdAt: now, updatedAt: now, baselineName: input.baselineName!, candidateName: input.candidateName!, goal: input.goal!, ...(input.providerId === undefined ? {} : { providerId: input.providerId }), engineVersion: ENGINE_VERSION, inputFingerprints: { baseline: fingerprintOpenApiInput(input.baseline), candidate: fingerprintOpenApiInput(input.candidate), ...(input.consumerEvidence === undefined ? {} : { consumerEvidence: fingerprintObject(input.consumerEvidence) }) }, verdict: null, steps: [], upstream: { validationErrors: 0, breakingCount: 0, warningCount: 0, findings: [], truncated: false }, summary: '等待检查。', recommendations: [], limitations: ['仅分析提交的契约与调用样例；不访问实际服务，不修改代码，不证明生产环境完全兼容。', '记录包含诊断信息与字段名称；原始契约、请求响应正文和模型原始回复不保存。'], plannerCalls: 0 };
    run.requiredTools = [...mandatory, ...(input.caller ? ['caller-analysis' as const] : []), ...(prepared ? ['project-tests' as const] : [])];
    if (input.caller || prepared) run.limitations = ['契约与有限 AST 检查离线执行；注册的可信项目测试是真实代码执行，可能使用网络或自身已有依赖，不属于操作系统安全沙箱。', '本地报告可能包含项目路径、测试输出和观测数据；关联的调用方记录还可能包含候选源码。内置模型只接收固定状态、计数与证据编号，不接收源码、响应正文或测试输出。'];
    if (input.caller) {
      run.inputFingerprints.caller = fingerprintObject(input.caller);
      run.limitations.push('调用方源码由有限 AST 解释器重放；候选源码与观测值可出现在关联报告，原始输入包不持久化，内置模型不接收这些原文。');
    }
    if (prepared) {
      run.project = prepared.metadata; run.inputFingerprints.project = prepared.metadata.snapshotFingerprint;
      run.limitations.push('已授权的本机项目测试会执行真实代码，并在独立副本中应用注册的场景文件；这是可信项目执行器，不是恶意代码安全沙箱。测试输出仅保存在本地报告，不发送给内置模型。');
    }
    if (!input.consumerEvidence && !input.caller && !prepared) run.limitations.push('未提交调用方证据；静态规则无报错也只会得到 review。');
    this.records.set(run.id, run); this.inputs.set(run.id, input);
    try { await this.save(run); } catch (error) { this.records.delete(run.id); this.inputs.delete(run.id); throw error; }
    if (prepared) this.projects.set(run.id, prepared);
    const queued = structuredClone(run);
    this.queue.push(run.id); queueMicrotask(() => { void this.pump(); });
    return queued;
  }
  async get(id: string): Promise<AgentRun | null> { await this.ready(); await this.flush(); return this.records.has(id) ? structuredClone(this.records.get(id)!) : null; }
  async list(): Promise<AgentRunSummary[]> {
    await this.ready(); await this.flush();
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => ({ id: run.id, mode: run.mode, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, baselineName: run.baselineName, candidateName: run.candidateName, goal: run.goal, verdict: run.verdict, summary: run.summary, plannerCalls: run.plannerCalls, completedSteps: run.steps.filter((step) => step.status === 'completed').length, totalSteps: final(run) ? run.steps.length : Math.max(requiredTools(run).length, run.steps.length) }));
  }
  async wait(id: string): Promise<AgentRun> {
    await this.ready(); const run = this.records.get(id);
    if (!run) throw new AgentError(404, 'AGENT_NOT_FOUND', 'Agent task was not found.');
    if (!final(run)) await new Promise<AgentRun>((accept) => { this.waiters.set(id, [...(this.waiters.get(id) ?? []), accept]); });
    await this.flush(); return structuredClone(run);
  }
  private notify(run: AgentRun): void { for (const accept of this.waiters.get(run.id) ?? []) accept(structuredClone(run)); this.waiters.delete(run.id); }
  async cancel(id: string): Promise<AgentRun> {
    await this.ready(); const run = this.records.get(id);
    if (!run) throw new AgentError(404, 'AGENT_NOT_FOUND', 'Agent task was not found.');
    if (final(run)) { await this.flush(); return structuredClone(run); }
    run.status = 'cancelled'; run.verdict = 'review'; run.finishedAt = stamp(); run.summary = '任务已取消；已完成的检查保留，不能视为完整验收。';
    for (const step of run.steps) if (step.status === 'running') { step.status = 'failed'; step.finishedAt = stamp(); step.summary = '已取消。'; }
    this.controllers.get(id)?.abort(); this.inputs.delete(id);
    const index = this.queue.indexOf(id); if (index >= 0) this.queue.splice(index, 1);
    this.projects.delete(id); this.callerReports.delete(id);
    await this.save(run); this.notify(run); return structuredClone(run);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.callerExecutor.close();
    if (!this.readyPromise) return;
    await this.ready();
    for (const run of this.records.values()) if (!final(run)) await this.cancel(run.id);
    await this.flush();
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const id = this.queue.shift()!; const run = this.records.get(id); const input = this.inputs.get(id);
        if (run && input && !final(run)) await this.execute(run, input);
      }
    } finally { this.pumping = false; }
  }
  private async execute(run: AgentRun, input: AgentRunInput): Promise<void> {
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    const timer = setTimeout(() => controller.abort(), MAX_DURATION);
    try {
      run.status = 'running'; run.startedAt = stamp(); run.summary = '正在检查提交的输入。'; await this.save(run);
      const engine = await aborted(this.runner.status(), controller.signal);
      if (!engine.available) throw new AgentError(503, 'AGENT_ENGINE_UNAVAILABLE', 'Pinned oasdiff engine is unavailable; install it before running the agent.');
      run.upstreamVersion = engine.version ?? engine.pinnedVersion;
      for (let turn = 0; turn < AGENT_TOOLS.length + 2; turn++) {
        if (controller.signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled or exceeded its time budget.');
        const context = observation(run);
        let decision: AgentDecision;
        if (run.mode === 'llm') {
          run.plannerCalls++; await this.save(run);
          decision = validateDecision(await aborted(this.planner().decide(context, { ...(run.providerId === undefined ? {} : { providerId: run.providerId }), signal: controller.signal, onRetry: async () => { run.plannerCalls++; await this.save(run); } }), controller.signal), context);
        } else {
          const next = requiredTools(run).find((tool) => context.availableTools.includes(tool));
          decision = next ? { tool: next, purpose: purposes[next] } : { tool: 'finish', purpose: '汇总检查结果和迁移事项' };
        }
        if (final(run) || controller.signal.aborted) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled.');
        if (decision.tool === 'finish') {
          run.verdict = verdict(run); run.status = 'completed'; run.finishedAt = stamp();
          run.summary = decision.summary ?? `检查完成：${run.verdict}。上游发现 ${run.upstream.breakingCount} 项错误级兼容风险，${run.upstream.warningCount} 项警告。${run.coreAnalysis?.consumerImpact ? `独立响应样例检查回归 ${run.coreAnalysis.consumerImpact.summary.regressions} 项。` : run.callerReview || run.projectTests ? '' : '未提交独立调用方验证证据。'}`;
          if (!decision.summary && (run.callerReview || run.projectTests)) run.summary += ` 源码回归 ${run.callerReview?.summary.regressions ?? '未检查'} 项；项目测试 ${run.projectTests?.status ?? '未运行'}，补丁真实测试 ${run.projectTests?.patchStatus ?? '未运行'}。`;
          run.recommendations = decision.recommendations?.length ? decision.recommendations : recommendations(run);
          await this.save(run); return;
        }
        await this.executeTool(run, input, decision, controller.signal);
        run.verdict = verdict(run); await this.save(run);
      }
      throw new AgentError(502, 'AGENT_STEP_LIMIT', 'Planner did not finish within its action budget.');
    } catch (error) {
      if (run.status !== 'cancelled') {
        run.status = 'failed'; run.verdict = verdict(run) === 'blocked' ? 'blocked' : 'review'; run.finishedAt = stamp();
        run.error = error instanceof AgentError ? { code: error.code, message: error.message } : { code: 'AGENT_TOOL_FAILED', message: 'An analysis tool failed. Check the engine installation and input format; tool stderr was not stored.' };
        run.summary = run.error.message;
        if (error instanceof AgentError && error.code === 'AGENT_REPORT_LIMIT') {
          delete run.coreAnalysis;
          delete run.projectTests; delete run.callerReview;
          run.upstream.findings = run.upstream.findings.slice(0, 50); run.upstream.truncated = true; run.recommendations = [];
          run.limitations.push('分析结果超过存储上限，已移除分析明细并保存最小失败记录。');
        }
        for (const step of run.steps) if (step.status === 'running') { step.status = 'failed'; step.finishedAt = stamp(); step.summary = run.error.message; }
        await this.save(run).catch(() => { run.error = { code: 'AGENT_PERSIST_FAILED', message: 'Task failed and its final state could not be persisted.' }; });
      }
    } finally { clearTimeout(timer); this.controllers.delete(run.id); this.inputs.delete(run.id); this.riskLedger.delete(run.id); this.projects.delete(run.id); this.callerReports.delete(run.id); this.notify(run); }
  }
  private async executeTool(run: AgentRun, input: AgentRunInput, decision: AgentDecision, signal: AbortSignal): Promise<void> {
    if (decision.tool === 'finish') return;
    const step: AgentStep = { id: `STEP-${String(run.steps.length + 1).padStart(2, '0')}`, tool: decision.tool, purpose: decision.purpose, status: 'running', startedAt: stamp(), summary: '正在执行。', evidenceIds: [] };
    run.steps.push(step); await this.save(run);
    if (signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled.');
    if (decision.tool === 'caller-analysis') {
      if (!input.caller) throw new AgentError(400, 'AGENT_CALLER_MISSING', 'No caller input was supplied for this review.');
      const report = await this.callerExecutor.run({ schemaVersion: 1, baseline: input.baseline, candidate: input.candidate, ...input.caller }, signal);
      if (signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled.');
      const saved = { id: randomUUID(), createdAt: stamp(), report };
      await this.callerStore.save(saved);
      if (signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled after caller evidence was saved. Check caller history before retrying.');
      this.callerReports.set(run.id, report);
      run.callerReview = {
        id: saved.id, createdAt: saved.createdAt, evidenceKind: report.evidenceKind, inputFingerprint: report.inputFingerprint,
        sourceFiles: report.sourceFiles, summary: report.summary, gate: report.gate,
        checks: report.checks.map((check) => ({ id: `CALLER-${check.id}`, sourceCheckId: check.id, scenarioId: check.scenarioId, file: check.file, exportName: check.exportName, status: check.status })),
        patches: report.patches.map((patch) => ({ id: `CALLER-${patch.id}`, sourcePatchId: patch.id, file: patch.file, status: patch.verification.status })),
        // These engine diagnostics can include user-supplied names; keep them in the local caller record only.
        limitations: ['完整源码、场景结果、候选补丁及范围说明保存在关联的调用方审查记录中。有限 AST 重放通过不代表完整项目测试通过。'],
      };
      step.evidenceIds = [...run.callerReview.checks.map((item) => item.id), ...run.callerReview.patches.map((item) => item.id)];
      step.summary = `调用方源码：${report.summary.callsites} 个调用点，${report.summary.regressions} 项回归，${report.summary.inconclusive} 项无法确定，${report.summary.verifiedPatches} 份候选补丁通过有限重放。`;
    } else if (decision.tool === 'project-tests') {
      const prepared = this.projects.get(run.id);
      if (!prepared) throw new AgentError(400, 'AGENT_PROJECT_MISSING', 'This review has no registered project snapshot.');
      const tests = await runProjectTests(prepared, { patches: this.callerReports.get(run.id)?.patches ?? [], signal });
      if (signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Project testing was cancelled.');
      run.projectTests = tests;
      step.evidenceIds = projectEvidence(run).map((item) => item.id);
      step.summary = `项目已有测试：${tests.status}；基线 ${tests.baseline.tests.passed}/${tests.baseline.tests.total} 通过，候选 ${tests.candidate.tests.passed}/${tests.candidate.tests.total} 通过；补丁 ${tests.patchStatus}。`;
      step.durationMs = tests.baseline.durationMs + tests.candidate.durationMs + (tests.patched?.durationMs ?? 0);
    } else if (decision.tool === 'native-analysis') {
      try {
        const analysis = analyzeRelease(input.baseline, input.candidate, input.consumerEvidence === undefined ? {} : { consumerEvidence: input.consumerEvidence });
        // Changes may contain schema defaults or enum literals. Keep diagnoses, never before/after payload fragments.
        for (const change of analysis.changes) {
          delete change.before; delete change.after;
          change.message = getRule(change.ruleId)?.description ?? '原生规则发现契约变化，请根据规则编号与位置复核。';
          change.recommendation = '检查此规则对应位置的兼容行为，保留迁移窗口，并补充调用方回归样例。';
        }
        for (const warning of analysis.coverage?.warnings ?? []) warning.message = `未覆盖的契约范围（${warning.code}）；需人工复核。`;
        if (analysis.changes.length > MAX_FINDINGS) { analysis.changes = analysis.changes.slice(0, MAX_FINDINGS); run.limitations.push('原生变更明细超过 200 条，仅保存前 200 条；汇总数量仍来自完整分析。'); run.upstream.truncated = true; }
        const bounded = boundedAnalysis(analysis);
        run.coreAnalysis = bounded.value;
        if (bounded.truncated) { run.upstream.truncated = true; run.limitations.push('分析中的超长元数据或过多明细已裁剪；汇总数量仍来自完整分析，请复核原始契约。'); }
        step.summary = `原生规则：${analysis.summary.breaking} 项破坏性变更，${analysis.summary.potentiallyBreaking} 项待复核风险；调用方检查 ${analysis.consumerImpact?.summary.checks ?? 0} 项，回归 ${analysis.consumerImpact?.summary.regressions ?? 0} 项。`;
        step.evidenceIds = [...analysis.changes.map((item) => item.id), ...(analysis.consumerImpact?.consumers.flatMap((consumer) => consumer.checks.map((check) => check.id)) ?? [])].slice(0, 250);
        if (analysis.coverage?.status !== 'complete') run.limitations.push('原生规则覆盖存在未确认范围，请查看 coreAnalysis.coverage。');
      } catch (error) {
        if (!(error instanceof ContractGuardError)) throw error;
        run.nativeUnavailable = `原生分析不可用（${error.code}）；上游检查独立保留，不能据此判定调用方安全。`;
        run.limitations.push(run.nativeUnavailable); step.summary = run.nativeUnavailable;
      }
    } else {
      const side = decision.tool === 'validate-baseline' ? 'baseline' : decision.tool === 'validate-candidate' ? 'candidate' : undefined;
      const command = side ? 'validate' : decision.tool as 'breaking' | 'changelog' | 'summary' | 'diff';
      const result = await aborted(this.runner.run(command, { baseline: input.baseline, candidate: input.candidate }, { signal, ...(side === undefined ? {} : { side }) }), signal);
      if (signal.aborted || final(run)) throw new AgentError(409, 'AGENT_ABORTED', 'Task was cancelled.');
      step.exitCode = result.exitCode; step.durationMs = result.durationMs; run.upstreamVersion = result.version;
      this.consumeResult(run, step, result, side);
    }
    step.status = 'completed'; step.finishedAt = stamp();
  }
  private consumeResult(run: AgentRun, step: AgentStep, result: AgentToolResult, side?: 'baseline' | 'candidate'): void {
    const ledger = this.riskLedger.get(run.id) ?? { validationErrors: {}, validationWarnings: {}, errors: new Set<string>(), warnings: new Set<string>() };
    this.riskLedger.set(run.id, ledger);
    const updateCounts = () => {
      run.upstream.validationErrors = Object.values(ledger.validationErrors).reduce((sum, count) => sum + count, 0);
      run.upstream.breakingCount = ledger.errors.size;
      run.upstream.warningCount = ledger.warnings.size + Object.values(ledger.validationWarnings).reduce((sum, count) => sum + count, 0);
    };
    if (side && result.exitCode === 102) {
      run.upstream[side === 'baseline' ? 'baselineValid' : 'candidateValid'] = false; ledger.validationErrors[side] = 1; updateCounts();
      step.summary = `${side} 契约无法被上游解析；跳过依赖有效契约的比较。`; step.evidenceIds = [step.id];
      run.limitations.push('契约加载失败，未执行兼容性比较；原始诊断可能含源文件内容，因此未保存 stderr。'); return;
    }
    if (![0, 1].includes(result.exitCode)) throw new AgentError(502, 'AGENT_TOOL_EXIT', 'Upstream command did not complete successfully; raw stderr was not retained.');
    let output: unknown;
    try { output = JSON.parse(result.stdout); } catch { throw new AgentError(502, 'AGENT_TOOL_OUTPUT', 'Upstream command returned invalid JSON.'); }
    if (step.tool === 'diff' || step.tool === 'summary') {
      if (!isRecord(output) && !Array.isArray(output)) throw new AgentError(502, 'AGENT_TOOL_OUTPUT', 'Upstream structural output has an invalid shape.');
      const fields = Object.keys(output).length;
      step.summary = `${step.tool} 已完成：${fields} 个顶层结果项；结果指纹 ${fingerprintObject(output).value}。仅保存结构统计，未保存完整契约差异。`; step.evidenceIds = [step.id]; return;
    }
    if (!Array.isArray(output) || output.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string' || ![1, 2, 3].includes(Number(item.level)))) throw new AgentError(502, 'AGENT_TOOL_OUTPUT', 'Upstream findings do not match the pinned engine output format.');
    const findings = output as Array<Record<string, unknown>>;
    const errors = findings.filter((item) => item.level === 3).length;
    const warnings = findings.filter((item) => item.level === 2).length;
    if (side) {
      run.upstream[side === 'baseline' ? 'baselineValid' : 'candidateValid'] = result.exitCode === 0 && errors === 0;
      ledger.validationErrors[side] = errors || (result.exitCode === 1 ? 1 : 0);
      ledger.validationWarnings[side] = warnings;
    }
    for (const item of findings) {
      const ruleId = cleanText(item.id, 160); const operation = cleanText(item.operation, 20); const path = cleanText(item.path, 500);
      const diagnosticFingerprint = fingerprintObject({ id: item.id, text: item.text, operation, path }).value;
      if (!side && item.level === 3) ledger.errors.add(diagnosticFingerprint);
      if (!side && item.level === 2) ledger.warnings.add(diagnosticFingerprint);
      // Upstream prose can interpolate private enum/default values. Do not retain or forward that prose.
      const message = side ? '契约校验发现问题；请依据规则编号复核对应契约。' : '上游规则发现契约变化；请依据规则编号和操作位置确认兼容性影响。';
      const existing = run.upstream.findings.find((finding) => finding.fingerprint === diagnosticFingerprint);
      if (existing) { step.evidenceIds.push(existing.id); continue; }
      if (run.upstream.findings.length >= MAX_FINDINGS) { run.upstream.truncated = true; continue; }
      const finding: AgentFinding = { id: `OAS-${String(run.upstream.findings.length + 1).padStart(4, '0')}`, source: 'oasdiff', ruleId, fingerprint: diagnosticFingerprint, severity: item.level === 3 ? 'error' : item.level === 2 ? 'warning' : 'info', message, ...(operation ? { operation } : {}), ...(path ? { path } : {}) };
      run.upstream.findings.push(finding); step.evidenceIds.push(finding.id);
    }
    step.evidenceIds = [...new Set(step.evidenceIds)];
    updateCounts();
    step.summary = `${side ?? step.tool}：${findings.length} 条诊断，${errors} 项错误级风险，${warnings} 项警告。`;
    if (run.upstream.truncated && !run.limitations.includes('上游诊断超过保存预算，报告仅保留部分明细；风险计数来自完整输出。')) run.limitations.push('上游诊断超过保存预算，报告仅保留部分明细；风险计数来自完整输出。');
  }
}
