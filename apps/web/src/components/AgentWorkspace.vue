<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { cancelAgentRun, createAgentRun, downloadAgentReport, getAgentRun, getAgentStatus, listAgentRuns, listAgentProjects } from '../agent-api'
import type { AgentInput, AgentMode, AgentRun, AgentRunState, AgentRunSummary, AgentStatus, AgentProject, AgentSubmission } from '../agent-types'
import { importAgentMigration } from '../agent-input'
import migrationExample from '../../../../fixtures/caller-impact/input.json'
import ConsumerImpactPanel from './ConsumerImpactPanel.vue'
import CoveragePanel from './CoveragePanel.vue'
import ProjectTestEvidence from './ProjectTestEvidence.vue'
import { formatDate } from '../utils'

const props = defineProps<{ input: AgentInput | null; inputIssue: string }>()
defineEmits<{ edit: []; openCaller: [id: string] }>()
const status = ref<AgentStatus | null>(null)
const mode = ref<AgentMode>('workflow')
const providerId = ref('')
const inputSource = ref<'editor' | 'project' | 'migration'>('editor')
const projects = ref<AgentProject[]>([])
const projectId = ref('')
const projectError = ref('')
const projectsLoading = ref(false)
const migrationInput = shallowRef<AgentInput | null>(null)
const migrationError = ref('')
const migrationName = ref('')
const importing = ref(false)
let importSequence = 0
let projectSequence = 0
const chosenProject = computed(() => projects.value.find((project) => project.id === projectId.value))
const chosenInput = computed(() => inputSource.value === 'migration' ? migrationInput.value : props.input)
const goal = ref('检查此次发布的兼容性风险，结合调用方证据给出可验证的迁移建议。')
const runs = ref<AgentRunSummary[]>([])
const selected = ref<AgentRun | null>(null)
const error = ref('')
const historyError = ref('')
const statusError = ref('')
const loading = ref(true)
const submitting = ref(false)
const opening = ref(false)
const cancelling = ref(false)
const pollPaused = ref(false)
let alive = true
let sequence = 0
let timer: number | undefined
let controller: AbortController | null = null
const lifecycle = new AbortController()
const stateLabels: Record<AgentRunState, string> = { queued: '排队中', running: '检查中', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' }
const toolLabels: Record<string, string> = { 'validate-baseline': '校验基线规范', 'validate-candidate': '校验候选规范', breaking: '检查破坏性变更', changelog: '生成变更清单', 'native-analysis': '检查契约与调用方证据', summary: '检查变更统计', diff: '读取结构差异', 'caller-analysis': '定位调用方并验证候选补丁', 'project-tests': '运行项目已有测试' }
const busy = computed(() => selected.value?.status === 'queued' || selected.value?.status === 'running')
const canStart = computed(() => (inputSource.value === 'project' ? Boolean(chosenProject.value) && !projectsLoading.value : Boolean(chosenInput.value) && !importing.value) && !submitting.value && !opening.value && !cancelling.value && !loading.value && Boolean(mode.value === 'workflow' ? status.value?.workflowAvailable : status.value?.llmAvailable))
const knownEvidence = computed(() => new Set([...(selected.value?.steps.flatMap((step) => [step.id, ...step.evidenceIds]) ?? []), ...(selected.value?.upstream.findings.map((finding) => finding.id) ?? []), ...(selected.value?.coreAnalysis?.changes.map((change) => change.id) ?? []), ...(selected.value?.coreAnalysis?.consumerImpact?.consumers.flatMap((consumer) => consumer.checks.map((check) => check.id)) ?? []), ...(selected.value?.callerReview?.checks.map((check) => check.id) ?? []), ...(selected.value?.callerReview?.patches.map((patch) => patch.id) ?? [])]))
function message(value: unknown): string { return value instanceof Error ? value.message : '任务操作未完成，请重试。' }
async function refreshProjects(): Promise<void> {
  const token = ++projectSequence
  projectsLoading.value = true
  projectError.value = ''
  try {
    const result = await listAgentProjects(lifecycle.signal)
    if (alive && token === projectSequence) { projects.value = result; if (!result.some((project) => project.id === projectId.value)) projectId.value = '' }
  } catch (cause) { if (alive && token === projectSequence) { projects.value = []; projectId.value = ''; projectError.value = message(cause) } }
  finally { if (alive && token === projectSequence) projectsLoading.value = false }
}
function loadMigrationExample(): void {
  importSequence++
  importing.value = false
  migrationError.value = ''
  migrationInput.value = importAgentMigration(JSON.stringify(migrationExample))
  migrationName.value = '订单与联系邮箱迁移示例'
  inputSource.value = 'migration'
}
async function importMigration(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  const token = ++importSequence
  importing.value = true
  migrationInput.value = null
  migrationError.value = ''
  migrationName.value = ''
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error('迁移材料超过 12 MiB，请缩小范围。')
    const text = await file.text()
    if (alive && token === importSequence) { migrationInput.value = importAgentMigration(text); migrationName.value = file.name }
  } catch (cause) { if (alive && token === importSequence) migrationError.value = message(cause) }
  finally { if (alive && token === importSequence) importing.value = false }
}
function stopPolling(): void {
  sequence += 1
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  controller?.abort()
  controller = null
}
function remember(id: string): void { try { localStorage.setItem('contractguard.agent.last-run', id) } catch { /* History also remains available from the server. */ } }
function installRun(run: AgentRun): void {
  selected.value = run
  remember(run.id)
  const summary: AgentRunSummary = { ...run, completedSteps: run.steps.filter((step) => step.status === 'completed').length, totalSteps: run.steps.length }
  runs.value = [summary, ...runs.value.filter((item) => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
async function refreshHistory(): Promise<void> {
  historyError.value = ''
  try { const result = await listAgentRuns(lifecycle.signal); if (alive) { runs.value = result; if (selected.value) installRun(selected.value) } }
  catch (cause) { if (alive) historyError.value = message(cause) }
}
function poll(id: string, token: number, until: number): void {
  if (!alive || token !== sequence || !busy.value) return
  if (Date.now() >= until) { pollPaused.value = true; return }
  timer = window.setTimeout(async () => {
    controller = new AbortController()
    try {
      const run = await getAgentRun(id, controller.signal)
      if (!alive || token !== sequence) return
      installRun(run)
      poll(id, token, until)
    } catch (cause) {
      if (!alive || token !== sequence) return
      error.value = `状态更新已暂停：${message(cause)}`
      pollPaused.value = true
    }
  }, 1500)
}
function follow(run: AgentRun): void {
  installRun(run)
  pollPaused.value = false
  poll(run.id, sequence, Date.now() + Math.min((status.value?.limits.maxDurationMs ?? 180_000) + 30_000, 600_000))
}
async function openRun(id: string): Promise<void> {
  stopPolling()
  const token = sequence
  error.value = ''
  opening.value = true
  controller = new AbortController()
  try { const run = await getAgentRun(id, controller.signal); if (alive && token === sequence) follow(run) }
  catch (cause) { if (alive && token === sequence) error.value = message(cause) }
  finally { if (alive && token === sequence) opening.value = false }
}
async function start(): Promise<void> {
  if (!canStart.value) return
  stopPolling()
  const token = sequence
  submitting.value = true
  error.value = ''
  controller = new AbortController()
  // The task receives an immutable input snapshot; later editor changes cannot alter this run.
  const snapshot = JSON.parse(JSON.stringify(inputSource.value === 'project' ? { projectId: projectId.value } : chosenInput.value)) as AgentSubmission
  try {
    const run = await createAgentRun({ ...snapshot, mode: mode.value, goal: goal.value, ...(mode.value === 'llm' && status.value?.planner.allowProfileOverride && providerId.value ? { providerId: providerId.value } : {}) }, controller.signal)
    if (alive && token === sequence) follow(run)
  } catch (cause) { if (alive && token === sequence) error.value = message(cause) }
  finally { if (alive && token === sequence) submitting.value = false }
}
async function cancel(): Promise<void> {
  if (!selected.value || !busy.value || cancelling.value) return
  const id = selected.value.id
  stopPolling()
  const token = sequence
  cancelling.value = true
  controller = new AbortController()
  try { const run = await cancelAgentRun(id, controller.signal); if (alive && token === sequence) follow(run) }
  catch (cause) { if (alive && token === sequence) { error.value = message(cause); pollPaused.value = true } }
  finally { if (alive && token === sequence) cancelling.value = false }
}
async function exportRun(format: 'json' | 'markdown'): Promise<void> {
  if (!selected.value) return
  try { await downloadAgentReport(selected.value.id, format) } catch (cause) { if (alive) error.value = message(cause) }
}
async function refreshStatus(): Promise<void> {
  loading.value = true
  statusError.value = ''
  try { const result = await getAgentStatus(lifecycle.signal); if (alive) { status.value = result; providerId.value = result.planner.activeProfile ?? '' } }
  catch (cause) { if (alive) { status.value = null; statusError.value = message(cause) } }
  finally { if (alive) loading.value = false }
}
onMounted(async () => {
  void refreshHistory()
  void refreshProjects()
  await refreshStatus()
  if (!alive) return
  let id = ''
  try { id = localStorage.getItem('contractguard.agent.last-run') ?? '' } catch { /* Storage is optional. */ }
  if (id) await openRun(id)
})
onBeforeUnmount(() => { alive = false; importSequence++; projectSequence++; stopPolling(); lifecycle.abort() })
</script>

<template>
  <section class="agent-workspace" aria-labelledby="agent-title">
    <header class="page-heading">
      <div><h1 id="agent-title">发布审查任务</h1><p>从契约、调用方代码到已有测试，在同一任务中检查并保留迁移证据。</p></div>
      <button class="button button--quiet" type="button" @click="$emit('edit')">编辑契约与调用方样例</button>
    </header>
    <div class="engine-strip" aria-live="polite">
      <strong>oasdiff {{ status?.engine.version ?? status?.engine.pinnedVersion ?? '—' }}</strong>
      <span :class="status?.engine.available ? 'status-good' : 'status-warning'">{{ loading ? '正在检测检查引擎…' : status?.engine.available ? '本地检查引擎就绪' : '本地检查引擎未就绪' }}</span>
      <span v-if="status?.engine.reason">{{ status.engine.reason }}</span>
      <span v-if="statusError" role="alert">{{ statusError }}</span>
      <button class="text-button" type="button" :disabled="loading" @click="refreshStatus">重新检测</button>
      <span>页面运行受限检查流程；完整上游命令通过本地 CLI 使用。</span>
    </div>
    <div class="agent-layout">
      <aside class="agent-queue" aria-label="任务提交与历史">
        <form class="agent-form" @submit.prevent="start">
          <h2>新任务</h2>
          <label class="agent-field">材料来源<select v-model="inputSource"><option value="editor">当前契约编辑区</option><option value="project">已登记项目与测试</option><option value="migration">调用方迁移输入包</option></select></label>
          <template v-if="inputSource === 'project'">
            <label class="agent-field">选择项目<select v-model="projectId" :disabled="projectsLoading"><option value="">{{ projectsLoading ? '正在读取…' : '请选择已登记项目' }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.label }}</option></select></label>
            <p v-if="projectError" role="alert">{{ projectError }}</p>
            <p v-else-if="!projects.length && !projectsLoading" class="muted">尚未登记项目。按使用指南在本机配置契约与测试位置，再刷新列表。</p>
            <button type="button" class="text-button" :disabled="projectsLoading" @click="refreshProjects">刷新项目</button>
            <p v-if="chosenProject" class="agent-boundary">{{ chosenProject.testsEnabled ? '自动读取登记的文件，并在副本中执行该项目已授权的测试。' : '该项目未启用真实测试；只运行可用分析。' }}</p>
          </template>
          <template v-else>
            <div v-if="inputSource === 'migration'" class="agent-migration-input"><label class="agent-field">导入迁移输入包<input type="file" accept=".json,application/json" :disabled="submitting" @change="importMigration" /></label><button type="button" class="text-button" @click="loadMigrationExample">使用调用方迁移示例</button><p v-if="migrationName" class="muted">{{ migrationName }}</p><p v-if="migrationError" role="alert">{{ migrationError }}</p><p v-if="importing" role="status">正在读取材料…</p></div>
            <div class="input-snapshot"><span>{{ inputSource === 'editor' ? '输入来自契约编辑区' : '输入来自迁移材料' }}</span><strong>{{ chosenInput?.baselineName ?? '尚未选择基线' }}</strong><span aria-hidden="true">↓</span><strong>{{ chosenInput?.candidateName ?? '尚未选择候选' }}</strong><small v-if="chosenInput">{{ chosenInput.caller ? `附带 ${chosenInput.caller.files.length} 个调用方文件` : chosenInput.consumerEvidence ? '附带调用方样例' : '未附带调用方样例' }}</small></div>
            <p v-if="!chosenInput && inputSource === 'editor'" class="agent-input-issue">{{ inputIssue }} <button type="button" class="text-button" @click="$emit('edit')">前往输入</button></p>
          </template>
          <fieldset class="agent-mode"><legend>执行方式</legend>
            <label><input v-model="mode" type="radio" value="workflow" name="agent-mode" /><span><strong>固定检查流程</strong><small>本地执行，不调用大模型</small></span></label>
            <label :class="{ unavailable: !status?.llmAvailable }"><input v-model="mode" type="radio" value="llm" name="agent-mode" :disabled="!status?.llmAvailable" /><span><strong>LLM 自主编排</strong><small>{{ status?.llmAvailable ? '模型选择检查顺序并提出建议' : '配置可用模型后启用' }}</small></span></label>
          </fieldset>
          <label v-if="mode === 'llm' && status?.planner.allowProfileOverride" class="agent-field">规划模型<select v-model="providerId"><option v-for="provider in status.planner.providers" :key="provider.id" :value="provider.id" :disabled="!provider.available">{{ provider.label }} · {{ provider.model }}</option></select></label>
          <p v-if="mode === 'llm'" class="cloud-disclosure">此模式会把任务目标、检查摘要和证据编号发送给配置的模型服务。请先确认目标文本适合发送；规则判定由检查结果计算。</p>
          <label class="agent-field">审查目标<textarea v-model="goal" maxlength="500" rows="3" /></label>
          <button class="button button--primary" type="submit" :disabled="!canStart"><span v-if="submitting" class="spinner" aria-hidden="true"></span>{{ submitting ? '正在提交…' : '开始审查' }}</button>
          <p class="agent-boundary">原始文件保持不变。项目测试仅适用于本机已登记、已信任的测试代码；普通子进程不提供安全沙箱。</p>
        </form>
        <section class="agent-history" aria-labelledby="task-history-title"><header><h2 id="task-history-title">最近任务</h2><button type="button" class="text-button" @click="refreshHistory">刷新</button></header>
          <p v-if="historyError" role="alert">{{ historyError }}</p>
          <p v-else-if="!runs.length" class="muted">暂无保存的任务。</p>
          <ol><li v-for="run in runs" :key="run.id"><button type="button" :aria-current="selected?.id === run.id ? 'true' : undefined" :disabled="submitting || cancelling" @click="openRun(run.id)"><span>{{ run.candidateName }}</span><small>{{ stateLabels[run.status] }} · {{ run.mode === 'llm' ? 'LLM' : '固定流程' }}</small><time>{{ formatDate(run.createdAt) }}</time></button></li></ol>
        </section>
      </aside>
      <div class="agent-review" :aria-busy="opening || submitting">
        <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
        <p v-if="opening" role="status">正在载入任务…</p>
        <template v-if="selected">
          <header class="agent-run-heading">
            <div>
              <div class="agent-report-title"><h2>审查结果</h2><span class="run-state" :data-state="selected.status">{{ stateLabels[selected.status] }}</span></div>
              <dl class="agent-contract-pair"><div><dt>基线</dt><dd>{{ selected.baselineName }}</dd></div><div><dt>候选</dt><dd>{{ selected.candidateName }}</dd></div></dl>
              <p>{{ selected.goal }}</p>
            </div>
            <button v-if="busy" type="button" class="button button--quiet" :disabled="cancelling || opening || submitting" @click="cancel">{{ cancelling ? '正在取消…' : '取消任务' }}</button>
          </header>
          <div class="agent-run-meta"><span>{{ selected.mode === 'llm' ? 'LLM 自主编排' : '固定检查流程 · 无大模型' }}</span><span>{{ formatDate(selected.createdAt) }}</span><span>{{ selected.steps.length }} 步检查 · {{ selected.plannerCalls }} 次模型调用</span><code>{{ selected.id }}</code></div>
          <nav class="report-nav" aria-label="审查报告目录"><a href="#agent-verdict">结论</a><a href="#agent-trace">检查过程</a><a href="#agent-findings">契约证据</a><a v-if="selected.callerReview" href="#agent-caller-title">调用方证据</a><a v-if="selected.projectTests" href="#project-tests-title">项目测试</a><a v-if="selected.recommendations.length" href="#agent-recommendations">迁移事项</a></nav>
          <p v-if="pollPaused" class="report-notice" role="status">自动刷新已暂停，任务仍可在服务端继续。<button class="text-button" type="button" @click="openRun(selected.id)">重新获取状态</button></p>
          <p v-if="selected.error" class="agent-error" role="alert">{{ selected.error.code }}：{{ selected.error.message }}</p>
          <section id="agent-verdict" class="agent-verdict" :data-verdict="selected.verdict ?? 'pending'"><div class="verdict-heading"><strong>{{ selected.verdict === 'blocked' ? '发现阻断项' : selected.verdict === 'review' ? '需要人工复核' : selected.verdict === 'pass' ? '已执行检查未发现阻断项' : '尚无完整判定' }}</strong><span>规则判定</span></div><p>{{ selected.summary || '等待检查结果。' }}</p><small>任务状态与兼容性结论分开记录；模型建议不能覆盖规则判定。</small></section>
          <section id="agent-trace" class="agent-trace" aria-labelledby="trace-title"><div class="section-heading"><h3 id="trace-title">检查过程</h3><span>{{ busy ? '执行中，自动更新' : '已保存的执行记录' }}</span></div><p v-if="!selected.steps.length" class="muted">任务已提交，等待执行第一步。</p><ol><li v-for="(step, index) in selected.steps" :key="step.id"><span class="trace-index">{{ String(index + 1).padStart(2, '0') }}</span><div><header><strong>{{ toolLabels[step.tool] ?? step.tool }}</strong><span :class="step.status === 'failed' ? 'status-danger' : 'muted'">{{ step.status === 'completed' ? '已完成' : step.status === 'failed' ? '失败' : '执行中' }}</span></header><p>{{ step.purpose }}</p><p v-if="step.summary">{{ step.summary }}</p><small v-if="step.durationMs !== undefined">{{ step.durationMs }} ms <template v-if="step.exitCode !== undefined">· 退出码 {{ step.exitCode }}</template></small><details v-if="step.evidenceIds.length"><summary>{{ step.evidenceIds.length }} 条证据索引</summary><div class="evidence-index"><code v-for="id in step.evidenceIds" :key="id">{{ id }}</code></div></details></div></li></ol></section>
          <section id="agent-findings" class="agent-findings"><div class="section-heading"><h3>上游检查证据</h3><span>阻断 {{ selected.upstream.breakingCount }} · 警告 {{ selected.upstream.warningCount }}</span></div><p v-if="!selected.upstream.findings.length" class="muted">{{ busy ? '等待检查输出。' : '本次没有可列出的上游发现；请结合执行状态与范围限制判断。' }}</p><article v-for="finding in selected.upstream.findings" :id="`evidence-${finding.id}`" :key="finding.id"><div><code>{{ finding.ruleId }}</code><span :class="finding.severity === 'error' ? 'status-danger' : 'status-warning'">{{ finding.severity }}</span></div><p>{{ finding.message }}</p><small>{{ finding.operation }} {{ finding.path }}</small><code class="evidence-id">{{ finding.id }}</code></article><p v-if="selected.upstream.truncated" class="report-notice">发现列表已截断，不能将当前可见条目视为全部结果。</p></section>
          <template v-if="selected.coreAnalysis"><CoveragePanel :coverage="selected.coreAnalysis.coverage" /><ConsumerImpactPanel :report="selected.coreAnalysis.consumerImpact" /><details class="agent-native"><summary>ContractGuard 规则证据（{{ selected.coreAnalysis.changes.length }} 条）</summary><article v-for="change in selected.coreAnalysis.changes" :key="change.id"><code>{{ change.id }} · {{ change.ruleId }}</code><p>{{ change.message }}</p><small>{{ change.location }}</small></article></details></template>
          <p v-if="selected.nativeUnavailable" class="report-notice">ContractGuard 分析未完成：{{ selected.nativeUnavailable }}</p>
          <section v-if="selected.callerReview" class="agent-caller-evidence" aria-labelledby="agent-caller-title"><div class="section-heading"><h3 id="agent-caller-title">调用方迁移证据</h3><button type="button" class="text-button" @click="$emit('openCaller', selected.callerReview.id)">查看源码位置与补丁</button></div><p>{{ selected.callerReview.summary.files }} 个文件 · {{ selected.callerReview.summary.regressions }} 项样例回归 · {{ selected.callerReview.summary.inconclusive }} 项无法确定 · {{ selected.callerReview.summary.verifiedPatches }} 份补丁通过有限样例重放</p><p class="muted">样例重放与下面的项目测试是不同证据；未运行的检查不能视为通过。</p><code class="project-fingerprint">{{ selected.callerReview.id }}</code><ul><li v-for="check in selected.callerReview.checks" :key="check.id"><code>{{ check.id }}</code> · {{ check.file }} · {{ check.exportName }} · {{ check.status }}</li></ul></section>
          <ProjectTestEvidence v-if="selected.projectTests" :report="selected.projectTests" />
          <section v-if="selected.recommendations.length" id="agent-recommendations" class="agent-recommendations"><div class="section-heading"><h3>迁移事项</h3><span>{{ selected.mode === 'llm' ? '模型建议 · 需人工确认' : '基于检查结果的建议' }}</span></div><article v-for="(recommendation, index) in selected.recommendations" :key="index"><h4>{{ index + 1 }}. {{ recommendation.title }}</h4><ul><li v-for="(action, actionIndex) in recommendation.actions" :key="actionIndex">{{ action }}</li></ul><div class="evidence-index"><code v-for="id in recommendation.evidenceIds" :key="id" :class="{ 'status-warning': !knownEvidence.has(id) }">{{ id }}{{ knownEvidence.has(id) ? '' : '（未找到对应证据）' }}</code></div></article></section>
          <section v-if="selected.limitations.length" class="agent-limitations"><h3>范围与待验证事项</h3><ul><li v-for="(limitation, index) in selected.limitations" :key="index">{{ limitation }}</li></ul></section>
          <details class="report-provenance"><summary>输入快照与运行版本</summary><dl><dt>ContractGuard</dt><dd>{{ selected.engineVersion }}</dd><dt>oasdiff</dt><dd>{{ selected.upstreamVersion ?? '尚未执行' }}</dd><dt>基线摘要</dt><dd><code>{{ selected.inputFingerprints?.baseline?.value ?? '未记录' }}</code></dd><dt>候选摘要</dt><dd><code>{{ selected.inputFingerprints?.candidate?.value ?? '未记录' }}</code></dd><dt>模型配置</dt><dd>{{ selected.providerId ?? (selected.mode === 'llm' ? '服务默认配置' : '未使用大模型') }}</dd></dl></details>
          <footer class="agent-export"><span>执行记录在本机服务中保存，可随时从最近任务重新打开。</span><button type="button" class="button button--quiet" @click="exportRun('markdown')">导出 Markdown</button><button type="button" class="button button--quiet" @click="exportRun('json')">导出 JSON</button></footer>
        </template>
        <div v-else-if="!opening" class="agent-empty"><h2>把变更交给检查流程。</h2><p>选择已登记项目、导入调用方迁移包，或使用编辑区的契约，再提交审查。这里会逐步展示检查动作、规则证据和迁移事项。</p><ol><li><strong>校验输入</strong><span>确认两侧契约可被检查引擎解析。</span></li><li><strong>执行检查</strong><span>检查契约与调用方，并运行已登记的项目测试。</span></li><li><strong>复核迁移</strong><span>沿证据定位风险，保留未覆盖范围。</span></li></ol></div>
      </div>
    </div>
  </section>
</template>
