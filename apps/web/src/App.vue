<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AgentWorkspace from './components/AgentWorkspace.vue'
import CallerWorkspace from './components/CallerWorkspace.vue'
import CegarWorkspace from './components/CegarWorkspace.vue'
import AiReportInterpreter from './components/AiReportInterpreter.vue'
import ChangeList from './components/ChangeList.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import RuleDrawer from './components/RuleDrawer.vue'
import SpecPanel from './components/SpecPanel.vue'
import SummaryCards from './components/SummaryCards.vue'
import CoveragePanel from './components/CoveragePanel.vue'
import ConsumerEvidenceInput from './components/ConsumerEvidenceInput.vue'
import ConsumerImpactPanel from './components/ConsumerImpactPanel.vue'
import { parseConsumerEvidence } from './consumer-evidence'
import { consumerExample } from './consumer-samples'
import {
  ApiError,
  checkHealth,
  createAnalysis,
  deleteAnalysis,
  downloadReport,
  getAnalysis,
  listAnalyses,
  listRules,
} from './api'
import { sampleBaseline, sampleCandidate, sampleBundles } from './samples'
import type { AnalysisRecord, ContractBundleInput, ExportFormat, RuleDefinition, ViewName } from './types'
import { formatDate } from './utils'

const view = ref<ViewName>('analyze')
const callerRecordId = ref<string>()
function openCallerReview(id: string) { callerRecordId.value = id; switchView('callers') }
const baseline = ref('')
const candidate = ref('')
const baselineName = ref('baseline.yaml')
const candidateName = ref('candidate.yaml')
const baselineBundle = ref<ContractBundleInput | null>(null)
const candidateBundle = ref<ContractBundleInput | null>(null)
const baselineReading = ref(false)
const candidateReading = ref(false)
const consumerEvidenceText = ref('')
const consumerReading = ref(false)
const workspaceReset = ref(0)
const activeAnalysis = ref<AnalysisRecord | null>(null)
const history = ref<AnalysisRecord[]>([])
const historyError = ref('')
const rules = ref<RuleDefinition[]>([])
const rulesError = ref('')
const isAnalyzing = ref(false)
const historyLoading = ref(false)
const rulesLoading = ref(false)
const rulesOpen = ref(false)
const apiOnline = ref<boolean | null>(null)
const toast = ref<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
const exportOpen = ref(false)
const exportMenu = ref<HTMLElement | null>(null)
const exportButton = ref<HTMLButtonElement | null>(null)
const historyReport = ref(false)
const submittedInput = ref('')
let analysisSequence = 0
let analysisController: AbortController | null = null
let historySequence = 0
let toastTimer: number | undefined

function hasContract(text: string, bundle: ContractBundleInput | null): boolean {
  return bundle !== null ? bundle.files.length > 0 && bundle.files.some((file) => file.path === bundle.entry) : Boolean(text.trim())
}
const filesLoading = computed(() => baselineReading.value || candidateReading.value || consumerReading.value)
const consumerInput = computed(() => {
  try { return { value: parseConsumerEvidence(consumerEvidenceText.value), error: '' } }
  catch (error) { return { value: undefined, error: error instanceof Error ? error.message : '调用方样例无法读取，请重新输入。' } }
})
const hasSpecs = computed(() => hasContract(baseline.value, baselineBundle.value) && hasContract(candidate.value, candidateBundle.value))
const currentInput = computed(() => JSON.stringify([baselineBundle.value ?? baseline.value, candidateBundle.value ?? candidate.value, baselineName.value, candidateName.value, consumerEvidenceText.value]))
const reportIsStale = computed(() => activeAnalysis.value !== null && !historyReport.value && currentInput.value !== submittedInput.value)
const agentInput = computed(() => hasSpecs.value && !filesLoading.value && !consumerInput.value.error ? {
  baseline: baselineBundle.value ?? baseline.value,
  candidate: candidateBundle.value ?? candidate.value,
  baselineName: baselineName.value,
  candidateName: candidateName.value,
  ...(consumerInput.value.value ? { consumerEvidence: consumerInput.value.value } : {}),
} : null)
const agentInputIssue = computed(() => filesLoading.value ? '请等待文件读取完成。' : consumerInput.value.error || '请先载入基线和候选规范。')

function cancelAnalysis(): void {
  analysisSequence += 1
  analysisController?.abort()
  analysisController = null
  isAnalyzing.value = false
}

function resetFileReads(): void {
  workspaceReset.value += 1
  baselineReading.value = false
  candidateReading.value = false
  consumerReading.value = false
}

function onConsumerLoading(loading: boolean): void {
  consumerReading.value = loading
  if (loading) cancelAnalysis()
}

function onFileLoading(side: 'baseline' | 'candidate', loading: boolean): void {
  if (side === 'baseline') baselineReading.value = loading
  else candidateReading.value = loading
  if (loading) cancelAnalysis()
}

// Inputs may remain editable while a request is running. Never attach its
// response to a newer workspace, even if an upstream ignores cancellation.
watch(currentInput, () => {
  if (analysisController !== null) cancelAnalysis()
}, { flush: 'sync' })

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toast.value = { message, type }
  toastTimer = window.setTimeout(() => {
    if (toast.value?.message === message) toast.value = null
    toastTimer = undefined
  }, 4200)
}

function friendlyError(error: unknown): string {
  if (error instanceof TypeError) return '无法连接分析服务，请确认服务已启动后重试。'
  if (error instanceof Error) return error.message
  return '操作未完成，请检查 API 服务与输入内容。'
}

function updateServiceStatus(error: unknown): void {
  if (error instanceof ApiError) apiOnline.value = true
  else if (error instanceof TypeError) apiOnline.value = false
}

function loadExample(): void {
  cancelAnalysis()
  resetFileReads()
  consumerEvidenceText.value = ''
  baselineBundle.value = null
  candidateBundle.value = null
  historyReport.value = false
  baseline.value = sampleBaseline
  candidate.value = sampleCandidate
  baselineName.value = 'campus-events-v1.4.yaml'
  candidateName.value = 'campus-events-v2.0.yaml'
  activeAnalysis.value = null
  view.value = 'analyze'
  showToast('已载入 Campus Events API 演示规范。', 'success')
}

function loadBundleExample(): void {
  cancelAnalysis()
  resetFileReads()
  consumerEvidenceText.value = ''
  const samples = sampleBundles()
  baseline.value = ''
  candidate.value = ''
  baselineBundle.value = samples.baseline
  candidateBundle.value = samples.candidate
  baselineName.value = 'Order Service v1 / openapi.yaml'
  candidateName.value = 'Order Service v2 / openapi.yaml'
  historyReport.value = false
  activeAnalysis.value = null
  view.value = 'analyze'
  showToast('已载入多文件示例：入口规范和 schemas/order.yaml；候选含尚未分析的 webhook，报告会单独提示覆盖范围。', 'success')
}

function loadConsumerExample(): void {
  cancelAnalysis()
  resetFileReads()
  const sample = consumerExample()
  baselineBundle.value = null
  candidateBundle.value = null
  baseline.value = sample.baseline
  candidate.value = sample.candidate
  baselineName.value = 'consumer-demo-baseline.json'
  candidateName.value = 'consumer-demo-candidate.json'
  consumerEvidenceText.value = sample.evidence
  historyReport.value = false
  activeAnalysis.value = null
  view.value = 'analyze'
  showToast('已载入规范和 3 个调用方的合成样例。运行分析可查看请求回归、响应约束失败和通过的对照。', 'success')
}

function clearWorkspace(): void {
  cancelAnalysis()
  resetFileReads()
  consumerEvidenceText.value = ''
  baselineBundle.value = null
  candidateBundle.value = null
  historyReport.value = false
  baseline.value = ''
  candidate.value = ''
  baselineName.value = 'baseline.yaml'
  candidateName.value = 'candidate.yaml'
  activeAnalysis.value = null
  exportOpen.value = false
}

async function runAnalysis(): Promise<void> {
  if (!hasSpecs.value || isAnalyzing.value || filesLoading.value || consumerInput.value.error) return
  cancelAnalysis()
  const sequence = analysisSequence
  const controller = new AbortController()
  analysisController = controller
  const snapshot = currentInput.value
  isAnalyzing.value = true
  try {
    const result = await createAnalysis({
      baseline: baselineBundle.value ?? baseline.value,
      candidate: candidateBundle.value ?? candidate.value,
      baselineName: baselineName.value,
      candidateName: candidateName.value,
      ...(consumerInput.value.value ? { consumerEvidence: consumerInput.value.value } : {}),
    }, controller.signal)
    if (sequence !== analysisSequence || controller.signal.aborted || snapshot !== currentInput.value) return
    activeAnalysis.value = result
    submittedInput.value = snapshot
    historyReport.value = false
    apiOnline.value = true
    showToast('分析完成，报告已保存到历史记录。', 'success')
    void refreshHistory()
    requestAnimationFrame(() => document.querySelector('#analysis-results')?.scrollIntoView({ behavior: 'smooth' }))
  } catch (error) {
    if (sequence !== analysisSequence || controller.signal.aborted) return
    updateServiceStatus(error)
    showToast(friendlyError(error), 'error')
  } finally {
    if (sequence === analysisSequence) {
      analysisController = null
      isAnalyzing.value = false
    }
  }
}

async function refreshHistory(): Promise<void> {
  const sequence = ++historySequence
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await listAnalyses()
    if (sequence !== historySequence) return
    history.value = result
    apiOnline.value = true
  } catch (error) {
    if (sequence !== historySequence) return
    historyError.value = friendlyError(error)
    updateServiceStatus(error)
    if (view.value !== 'history') showToast(historyError.value, 'error')
  } finally {
    if (sequence === historySequence) historyLoading.value = false
  }
}

async function openHistory(analysis: AnalysisRecord): Promise<void> {
  cancelAnalysis()
  const sequence = analysisSequence
  const controller = new AbortController()
  analysisController = controller
  try {
    const result = await getAnalysis(analysis.id, controller.signal)
    if (sequence !== analysisSequence || controller.signal.aborted) return
    activeAnalysis.value = result
    historyReport.value = true
    apiOnline.value = true
    view.value = 'analyze'
  } catch (error) {
    if (sequence !== analysisSequence || controller.signal.aborted) return
    updateServiceStatus(error)
    showToast(friendlyError(error), 'error')
  } finally {
    if (sequence === analysisSequence) analysisController = null
  }
}

function returnToWorkspace(): void {
  cancelAnalysis()
  historyReport.value = false
  activeAnalysis.value = null
}

async function removeHistory(analysis: AnalysisRecord): Promise<void> {
  if (!window.confirm(`确认删除分析记录 ${analysis.id}？该操作无法撤销。`)) return
  try {
    await deleteAnalysis(analysis.id)
    apiOnline.value = true
    history.value = history.value.filter((item) => item.id !== analysis.id)
    if (activeAnalysis.value?.id === analysis.id) activeAnalysis.value = null
    showToast('分析记录已删除。', 'success')
  } catch (error) {
    updateServiceStatus(error)
    showToast(friendlyError(error), 'error')
  }
}

async function loadRules(): Promise<void> {
  if (rulesLoading.value) return
  rulesLoading.value = true
  rulesError.value = ''
  try {
    rules.value = await listRules()
    apiOnline.value = true
  } catch (error) {
    rulesError.value = friendlyError(error)
    updateServiceStatus(error)
  } finally {
    rulesLoading.value = false
  }
}

function openRules(): void {
  rulesOpen.value = true
  if (!rules.value.length) void loadRules()
}

async function exportReport(format: ExportFormat): Promise<void> {
  if (!activeAnalysis.value) return
  exportOpen.value = false
  try {
    await downloadReport(activeAnalysis.value, format)
    apiOnline.value = true
    showToast(`已生成 ${format.toUpperCase()} 报告。`, 'success')
  } catch (error) {
    updateServiceStatus(error)
    showToast(friendlyError(error), 'error')
  }
}

function switchView(next: ViewName): void {
  cancelAnalysis()
  resetFileReads()
  if (next === 'analyze' && historyReport.value) returnToWorkspace()
  view.value = next
  exportOpen.value = false
  if (next === 'history') void refreshHistory()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (exportOpen.value && event.target instanceof Node && !exportMenu.value?.contains(event.target)) {
    exportOpen.value = false
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !exportOpen.value) return
  exportOpen.value = false
  exportButton.value?.focus()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  void (async () => {
    apiOnline.value = await checkHealth()
    if (apiOnline.value) void refreshHistory()
  })()
})

onBeforeUnmount(() => {
  cancelAnalysis()
  historySequence += 1
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" aria-label="ContractGuard 首页" @click.prevent="switchView('analyze')">
        <span class="brand-mark" aria-hidden="true">CG</span>
        <span><strong>ContractGuard</strong></span>
      </a>

      <nav aria-label="主导航">
        <button :class="{ active: view === 'analyze' }" type="button" :aria-current="view === 'analyze' ? 'page' : undefined" @click="switchView('analyze')">
          新建分析
        </button>
        <button :class="{ active: view === 'cegar' }" type="button" :aria-current="view === 'cegar' ? 'page' : undefined" @click="switchView('cegar')">自修复 Agent</button>
        <button :class="{ active: view === 'agent' }" type="button" :aria-current="view === 'agent' ? 'page' : undefined" @click="switchView('agent')">Agent 审查</button>
        <button :class="{ active: view === 'history' }" type="button" :aria-current="view === 'history' ? 'page' : undefined" @click="switchView('history')">
          分析历史
          <b v-if="history.length">{{ history.length }}</b>
        </button>
        <button type="button" @click="openRules">
          规则目录
        </button>
      </nav>

      <div class="sidebar-info">
        <span class="status-dot" :class="{ online: apiOnline === true, offline: apiOnline === false }"></span>
        <div>
          <strong>{{ apiOnline === null ? '正在检测服务' : apiOnline ? '分析引擎在线' : '分析引擎离线' }}</strong>
        </div>
      </div>
      <p class="version">v2.0.0</p>
    </aside>

    <main>
      <header class="topbar">
        <button class="mobile-brand" type="button" aria-label="返回新建分析" @click="switchView('analyze')">
          <span class="brand-mark" aria-hidden="true">CG</span> ContractGuard
        </button>
        <nav class="mobile-nav" aria-label="移动端主导航">
          <button type="button" :aria-current="view === 'analyze' ? 'page' : undefined" :class="{ active: view === 'analyze' }" @click="switchView('analyze')">分析</button>
          <button type="button" :aria-current="view === 'cegar' ? 'page' : undefined" :class="{ active: view === 'cegar' }" @click="switchView('cegar')">自修复</button>
          <button type="button" :aria-current="view === 'agent' ? 'page' : undefined" :class="{ active: view === 'agent' }" @click="switchView('agent')">Agent</button>
          <button type="button" :aria-current="view === 'history' ? 'page' : undefined" :class="{ active: view === 'history' }" @click="switchView('history')">历史</button>
          <button type="button" :aria-expanded="rulesOpen" @click="openRules">规则</button>
        </nav>
      </header>

      <div class="content">
        <template v-if="view === 'analyze'">
          <section class="page-heading">
            <div>
              <h1>{{ historyReport ? '历史分析报告' : 'OpenAPI 兼容性分析' }}</h1>
            </div>
            <div class="hero-actions">
              <button v-if="historyReport" class="button button--quiet" type="button" @click="returnToWorkspace">返回编辑区</button>
              <button v-else class="button button--quiet" type="button" @click="loadExample">载入演示规范</button>
              <button v-if="!historyReport" class="button button--quiet" type="button" @click="loadBundleExample">载入多文件示例</button>
              <button v-if="baseline || candidate || baselineBundle || candidateBundle || consumerEvidenceText || activeAnalysis || filesLoading" class="text-button danger-text" type="button" @click="clearWorkspace">清空</button>
            </div>
          </section>

          <section v-if="!historyReport" class="workspace" aria-label="输入规范" :aria-busy="isAnalyzing">
            <div class="spec-grid">
              <SpecPanel
                v-model="baseline"
                v-model:file-name="baselineName"
                v-model:bundle="baselineBundle"
                :reset-key="workspaceReset"
                title="基线规范"
                eyebrow="当前版本"
                accent="baseline"
                @error="showToast($event, 'error')"
                @loading="onFileLoading('baseline', $event)"
              />
              <div class="compare-arrow" aria-hidden="true">→</div>
              <SpecPanel
                v-model="candidate"
                v-model:file-name="candidateName"
                v-model:bundle="candidateBundle"
                :reset-key="workspaceReset"
                title="候选规范"
                eyebrow="待发布版本"
                accent="candidate"
                @error="showToast($event, 'error')"
                @loading="onFileLoading('candidate', $event)"
              />
            </div>

            <ConsumerEvidenceInput
              v-model="consumerEvidenceText"
              :error="consumerInput.error"
              :reset-key="workspaceReset"
              @loading="onConsumerLoading"
              @demo="loadConsumerExample"
            />

            <div class="analyze-bar">
              <button class="button button--quiet" type="button" :disabled="!hasSpecs || filesLoading || Boolean(consumerInput.error)" @click="switchView('agent')">交给 Agent 审查</button>
              <button class="button button--primary" type="button" :disabled="!hasSpecs || isAnalyzing || filesLoading || Boolean(consumerInput.error)" @click="runAnalysis">
                <span v-if="isAnalyzing" class="spinner"></span>
                {{ isAnalyzing ? '正在分析…' : filesLoading ? '正在读取文件…' : '运行兼容性分析' }}
              </button>
            </div>
          </section>

          <section v-if="activeAnalysis" id="analysis-results" class="results">
            <p v-if="reportIsStale" class="report-notice" role="status">输入已变更：下方报告对应上一次提交的规范，请重新运行分析。</p>
            <div class="section-heading report-heading">
              <div>
                <h2>{{ activeAnalysis.baselineName }} <span>→</span> {{ activeAnalysis.candidateName }}</h2>
                <p class="report-date">{{ formatDate(activeAnalysis.createdAt) }}</p>
              </div>
              <div ref="exportMenu" class="export-menu">
                <button ref="exportButton" class="button button--quiet" type="button" aria-controls="export-options" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen">
                  导出报告 <span aria-hidden="true">⌄</span>
                </button>
                <div v-if="exportOpen" id="export-options" class="export-popover" aria-label="选择报告格式">
                  <button type="button" @click="exportReport('markdown')">Markdown</button>
                  <button type="button" @click="exportReport('html')">HTML</button>
                  <button type="button" @click="exportReport('json')">JSON</button>
                </div>
              </div>
            </div>
            <SummaryCards :analysis="activeAnalysis" />
            <CoveragePanel :coverage="activeAnalysis.coverage" />
            <ConsumerImpactPanel :report="activeAnalysis.consumerImpact" :error="activeAnalysis.consumerImpactError" />
            <details class="report-provenance">
              <summary>报告来源与策略</summary>
              <dl>
                <dt>引擎版本</dt><dd>{{ activeAnalysis.engineVersion ?? '旧版记录未保存' }}</dd>
                <dt>规则策略</dt><dd>{{ activeAnalysis.policy?.id ?? '旧版记录未保存' }}</dd>
                <dt>基线方言</dt><dd>{{ activeAnalysis.source?.old.dialect ?? '旧版记录未保存' }}</dd>
                <dt>候选方言</dt><dd>{{ activeAnalysis.source?.new.dialect ?? '旧版记录未保存' }}</dd>
                <dt>基线 SHA-256</dt><dd><code>{{ activeAnalysis.source?.old.fingerprint?.value ?? '旧版记录未保存' }}</code></dd>
                <dt>候选 SHA-256</dt><dd><code>{{ activeAnalysis.source?.new.fingerprint?.value ?? '旧版记录未保存' }}</code></dd>
                <dt>策略 SHA-256</dt><dd><code>{{ activeAnalysis.policy?.fingerprint?.value ?? '旧版记录未保存' }}</code></dd>
              </dl>
              <div v-for="side in (['old', 'new'] as const)" :key="side">
                <template v-if="activeAnalysis.source?.[side].bundle">
                  <p>{{ side === 'old' ? '基线' : '候选' }}契约包入口：<code>{{ activeAnalysis.source[side].bundle!.entry }}</code>；实际依赖 {{ activeAnalysis.source[side].bundle!.files.length }} 个文件</p>
                  <ul class="bundle-audit-list"><li v-for="file in activeAnalysis.source[side].bundle!.files" :key="file.path"><code>{{ file.path }}</code><code>{{ file.fingerprint.value }}</code></li></ul>
                </template>
              </div>
            </details>
            <ChangeList :key="activeAnalysis.id" :analysis="activeAnalysis" />
            <AiReportInterpreter :key="activeAnalysis.id" :analysis-id="activeAnalysis.id" />
          </section>
        </template>

        <CegarWorkspace v-else-if="view === 'cegar'" />
        <AgentWorkspace v-else-if="view === 'agent'" :input="agentInput" :input-issue="agentInputIssue" @edit="switchView('analyze')" @open-caller="openCallerReview" />
        <CallerWorkspace v-else-if="view === 'callers'" :initial-review-id="callerRecordId" />
        <HistoryPanel
          v-else
          :analyses="history"
          :loading="historyLoading"
          :error="historyError"
          @open="openHistory"
          @remove="removeHistory"
          @refresh="refreshHistory"
        />
      </div>
    </main>

    <RuleDrawer
      :open="rulesOpen"
      :rules="rules"
      :loading="rulesLoading"
      :error="rulesError"
      @close="rulesOpen = false"
      @retry="loadRules"
    />

    <Transition name="toast">
      <div v-if="toast" class="toast" :class="`toast--${toast.type}`" :role="toast.type === 'error' ? 'alert' : 'status'" :aria-live="toast.type === 'error' ? 'assertive' : 'polite'">
        <span>{{ toast.type === 'success' ? '✓' : toast.type === 'error' ? '!' : 'i' }}</span>
        {{ toast.message }}
        <button type="button" aria-label="关闭通知" @click="toast = null">×</button>
      </div>
    </Transition>
  </div>
</template>
