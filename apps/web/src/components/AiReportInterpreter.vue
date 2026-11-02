<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { downloadAiReview, generateAiReview, getAiStatus, listAiReviews } from '../api'
import type { AiReviewReport, AiRiskLevel, AiServiceStatus } from '../types'
import { formatDate, selectableAiProviders } from '../utils'

const props = defineProps<{ analysisId: string }>()

const focus = ref('')
const status = ref<AiServiceStatus | null>(null)
const report = ref<AiReviewReport | null>(null)
const statusLoading = ref(true)
const generating = ref(false)
const statusError = ref('')
const reviewError = ref('')
const selectedProviderId = ref('')
const savedReviews = ref<AiReviewReport[]>([])
const savedLoading = ref(false)
const savedError = ref('')
const exportError = ref('')
const exporting = ref(false)
let requestSequence = 0
let generationRevision = 0
let statusController: AbortController | null = null
let reviewController: AbortController | null = null
let savedController: AbortController | null = null
let settingsEdited = false

const riskLabels: Record<AiRiskLevel, string> = {
  critical: '严重风险',
  high: '高风险',
  medium: '中等风险',
  low: '低风险',
}

const focusLength = computed(() => focus.value.length)
const availableProviders = computed(() =>
  status.value === null ? [] : selectableAiProviders(status.value),
)
const selectedProvider = computed(() =>
  availableProviders.value.find((provider) => provider.id === selectedProviderId.value),
)
const hasProviderProfiles = computed(() => (status.value?.providers.length ?? 0) > 0)
const serviceConfigured = computed(() =>
  hasProviderProfiles.value
    ? status.value?.allowRequestProviderOverride
      ? (status.value.providers.some((provider) => provider.enabled && provider.configured) ?? false)
      : status.value?.configured === true
    : status.value?.configured === true,
)
const serviceAvailable = computed(() =>
  hasProviderProfiles.value
    ? status.value?.allowRequestProviderOverride
      ? availableProviders.value.length > 0
      : status.value?.available === true && availableProviders.value.length > 0
    : status.value?.available === true,
)
const canGenerate = computed(() => {
  if (generating.value || status.value?.enabled !== true) return false
  return hasProviderProfiles.value
    ? selectedProvider.value !== undefined
    : status.value.available === true
})
const providerCaption = computed(() => {
  const provider = selectedProvider.value
  if (provider) return providerModelLabel(provider.displayName, provider.model)
  if (!status.value) return ''
  return providerModelLabel(status.value.provider, status.value.model)
})
const statusLabel = computed(() => {
  if (statusLoading.value) return '正在检测 AI 服务'
  if (statusError.value) return '状态检测失败'
  if (!status.value?.enabled) return '功能未启用'
  if (!serviceConfigured.value) return '等待 API 配置'
  if (!serviceAvailable.value) return '服务暂不可用'
  const providerName = selectedProvider.value?.displayName
  return providerName ? `${providerName} 配置就绪` : 'AI 配置就绪'
})
const statusTone = computed(() => {
  if (statusLoading.value) return 'checking'
  if (statusError.value || (status.value?.enabled && serviceConfigured.value && !serviceAvailable.value)) return 'error'
  if (!status.value?.enabled || !serviceConfigured.value) return 'inactive'
  return 'ready'
})
const tokenTotal = computed(() => {
  const usage = report.value?.usage
  if (!usage) return undefined
  return usage.totalTokens ??
    ((usage.promptTokens ?? usage.inputTokens) !== undefined &&
    (usage.completionTokens ?? usage.outputTokens) !== undefined
      ? (usage.promptTokens ?? usage.inputTokens ?? 0) +
        (usage.completionTokens ?? usage.outputTokens ?? 0)
      : undefined)
})

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return '无法连接分析服务，请确认服务已启动后重试。'
  return error instanceof Error ? error.message : '请求未完成，请稍后重试。'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function providerModelLabel(provider: string, model: string): string {
  return [provider, model].filter(Boolean).join(' · ') || 'AI 服务'
}

function reportProviderLabel(value: AiReviewReport): string {
  if (value.providerLabel) return providerModelLabel(value.providerLabel, value.model)
  const profile = status.value?.providers.find(
    (provider) => provider.id === value.providerId,
  )
  return providerModelLabel(profile?.displayName ?? value.provider, value.model)
}

function reviewKey(value: AiReviewReport): string {
  return value.id ?? `${value.providerId ?? value.provider}:${value.generatedAt}:${value.focus ?? ''}`
}

function mergeSavedReviews(values: AiReviewReport[]): void {
  const reviews = new Map<string, AiReviewReport>()
  // Newer local generation wins over a delayed history response with the same ID.
  for (const review of [...savedReviews.value, ...values]) {
    if (review.analysisId === props.analysisId && !reviews.has(reviewKey(review))) reviews.set(reviewKey(review), review)
  }
  savedReviews.value = [...reviews.values()].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
}

function restoreMatchingReview(): void {
  if (generating.value) return
  const sameProvider = (review: AiReviewReport): boolean => hasProviderProfiles.value
    ? review.providerId === selectedProviderId.value && review.model === selectedProvider.value?.model
      && review.provider === selectedProvider.value?.provider
    : review.provider === status.value?.provider && review.model === status.value?.model
  report.value = savedReviews.value.find((review) =>
    review.analysisId === props.analysisId
    && (review.language ?? 'zh-CN') === 'zh-CN'
    && (review.focus ?? '') === focus.value.trim()
    && sameProvider(review),
  ) ?? null
  if (!report.value && !settingsEdited) {
    const recent = savedReviews.value.find((review) => sameProvider(review) && (review.language ?? 'zh-CN') === 'zh-CN')
    if (recent) {
      focus.value = recent.focus ?? ''
      report.value = recent
    }
  }
  // Viewing a saved artifact is independent of whether its old provider is
  // currently configured. Its actual provider/model remain on the report.
  if (!report.value && !serviceAvailable.value && savedReviews.value.length) report.value = savedReviews.value[0]!
}

function updateFocus(event: Event): void {
  settingsEdited = true
  focus.value = (event.target as HTMLTextAreaElement).value
}

function updateProvider(event: Event): void {
  settingsEdited = true
  selectedProviderId.value = (event.target as HTMLSelectElement).value
}

async function loadSavedReviews(): Promise<void> {
  savedController?.abort()
  const controller = new AbortController()
  savedController = controller
  const analysisId = props.analysisId
  const revision = generationRevision
  savedLoading.value = true
  savedError.value = ''
  try {
    const values = await listAiReviews(analysisId, controller.signal)
    if (controller.signal.aborted || savedController !== controller || analysisId !== props.analysisId) return
    mergeSavedReviews(values)
    if (revision === generationRevision) restoreMatchingReview()
  } catch (error) {
    if (controller.signal.aborted || savedController !== controller) return
    savedError.value = errorMessage(error)
  } finally {
    if (savedController === controller) {
      savedController = null
      savedLoading.value = false
    }
  }
}

function cancelGeneration(): void {
  requestSequence += 1
  reviewController?.abort()
  reviewController = null
  generating.value = false
}

function selectSavedReview(event: Event): void {
  cancelGeneration()
  const key = (event.target as HTMLSelectElement).value
  const saved = savedReviews.value.find((review) => reviewKey(review) === key) ?? null
  settingsEdited = true
  if (saved) {
    focus.value = saved.focus ?? ''
    if (availableProviders.value.some((provider) => provider.id === saved.providerId)) selectedProviderId.value = saved.providerId!
  }
  report.value = saved
  reviewError.value = ''
  exportError.value = ''
}

async function exportReview(format: 'json' | 'markdown'): Promise<void> {
  if (!report.value?.id || exporting.value) return
  exporting.value = true
  exportError.value = ''
  try {
    await downloadAiReview(report.value, format)
  } catch (error) {
    exportError.value = errorMessage(error)
  } finally {
    exporting.value = false
  }
}

function chooseProvider(nextStatus: AiServiceStatus): void {
  const selectable = selectableAiProviders(nextStatus)
  const current = selectable.find((provider) => provider.id === selectedProviderId.value)
  if (current) return

  const preferredId = nextStatus.activeProviderId ?? nextStatus.defaultProviderId
  selectedProviderId.value =
    selectable.find((provider) => provider.id === preferredId)?.id ?? selectable[0]?.id ?? ''
}

async function loadStatus(): Promise<void> {
  statusController?.abort()
  const controller = new AbortController()
  statusController = controller
  statusLoading.value = true
  statusError.value = ''
  try {
    const nextStatus = await getAiStatus(controller.signal)
    if (statusController !== controller) return
    status.value = nextStatus
    chooseProvider(nextStatus)
    restoreMatchingReview()
  } catch (error) {
    if (isAbortError(error) || statusController !== controller) return
    status.value = null
    statusError.value = errorMessage(error)
  } finally {
    if (statusController === controller) {
      statusController = null
      statusLoading.value = false
    }
  }
}

async function generate(force = false): Promise<void> {
  if (!canGenerate.value) return
  reviewController?.abort()
  const controller = new AbortController()
  reviewController = controller
  const sequence = ++requestSequence
  generationRevision += 1
  const analysisId = props.analysisId
  const providerId = hasProviderProfiles.value ? selectedProviderId.value : ''
  generating.value = true
  reviewError.value = ''
  exportError.value = ''

  try {
    const trimmedFocus = focus.value.trim()
    const result = await generateAiReview(analysisId, {
      language: 'zh-CN',
      ...(trimmedFocus ? { focus: trimmedFocus } : {}),
      ...(providerId ? { providerId } : {}),
      ...(force ? { force: true } : {}),
    }, controller.signal)
    if (sequence === requestSequence && analysisId === props.analysisId) {
      mergeSavedReviews([result])
      report.value = result
    }
  } catch (error) {
    if (isAbortError(error)) return
    if (sequence === requestSequence && analysisId === props.analysisId) {
      reviewError.value = errorMessage(error)
    }
  } finally {
    if (reviewController === controller) reviewController = null
    if (sequence === requestSequence) generating.value = false
  }
}

watch(
  () => props.analysisId,
  () => {
    cancelGeneration()
    settingsEdited = false
    savedController?.abort()
    focus.value = ''
    report.value = null
    reviewError.value = ''
    savedReviews.value = []
    savedError.value = ''
    exportError.value = ''
    void loadSavedReviews()
  },
)

watch([selectedProviderId, focus], () => {
  cancelGeneration()
  reviewError.value = ''
  restoreMatchingReview()
}, { flush: 'sync' })

onMounted(() => {
  void loadStatus()
  void loadSavedReviews()
})
onBeforeUnmount(() => {
  cancelGeneration()
  statusController?.abort()
  savedController?.abort()
  statusController = null
  savedController = null
})
</script>

<template>
  <section class="ai-interpreter" aria-labelledby="ai-interpreter-title">
    <header class="ai-interpreter__header">
      <div class="ai-title-block">
        <div>
          <h2 id="ai-interpreter-title">AI 报告解读 <span>可选</span></h2>
          <p>基于规则结果生成风险摘要、迁移步骤和测试建议，不影响兼容性结论。</p>
        </div>
      </div>
      <span class="ai-status" :class="`ai-status--${statusTone}`" role="status" aria-live="polite">
        <i aria-hidden="true"></i>{{ statusLabel }}
      </span>
    </header>

    <div v-if="statusLoading" class="ai-state-card" aria-busy="true" aria-live="polite">
      <span class="spinner"></span>
      <div><strong>正在读取 AI 服务配置</strong><p>这不会发起模型请求，也不会发送分析数据。</p></div>
    </div>

    <div v-else-if="statusError" class="ai-state-card ai-state-card--error" role="alert">
      <span aria-hidden="true">!</span>
      <div><strong>无法获取 AI 服务状态</strong><p>{{ statusError }}</p></div>
      <button class="button button--quiet button--small" type="button" @click="loadStatus">重新检测</button>
    </div>

    <div v-else-if="!serviceAvailable" class="ai-state-card ai-state-card--setup">
      <span aria-hidden="true">⌁</span>
      <div>
        <strong>{{ status?.enabled ? (serviceConfigured ? 'AI 服务暂不可用' : '还差一步：配置 AI 服务') : 'AI 解释器当前未启用' }}</strong>
        <p v-if="status?.reason">{{ status.reason }}</p>
        <p v-else>请在 API 服务端启用 AI 功能并配置至少一个模型服务，重启后即可使用。</p>
        <small>密钥只保存在服务端，浏览器不会读取或保存 API Key。</small>
      </div>
      <button class="button button--quiet button--small" type="button" @click="loadStatus">重新检测</button>
    </div>

    <template v-if="!statusLoading">
      <div v-if="serviceAvailable" class="ai-controls">
        <div class="ai-focus-field">
          <div class="ai-focus-field__label">
            <label for="ai-review-focus">本次特别关注 <span>可选</span></label>
            <span :class="{ 'is-limit': focusLength >= 500 }">{{ focusLength }} / 500</span>
          </div>
          <textarea
            id="ai-review-focus"
            :value="focus"
            @input="updateFocus"
            maxlength="500"
            rows="3"
            aria-describedby="ai-focus-hint"
            placeholder="例如：重点评估移动端 v1 客户端的升级成本，以及无停机迁移方案。"
          ></textarea>
          <p id="ai-focus-hint">仅发送裁剪后的规则结果及此关注点；请勿填写密钥、个人信息或其他敏感数据。</p>
        </div>
        <div class="ai-generate-action">
          <label v-if="hasProviderProfiles" for="ai-provider-select">模型服务</label>
          <select
            v-if="hasProviderProfiles"
            id="ai-provider-select"
            :value="selectedProviderId"
            @change="updateProvider"
            :disabled="!status?.allowRequestProviderOverride || availableProviders.length <= 1"
          >
            <option v-for="provider in availableProviders" :key="provider.id" :value="provider.id">
              {{ providerModelLabel(provider.displayName, provider.model) }}
            </option>
          </select>
          <p v-else>{{ providerCaption }}</p>
          <button
            class="button button--ai"
            type="button"
            :disabled="!canGenerate"
            :aria-busy="generating"
            @click="generate(false)"
          >
            <span v-if="generating" class="spinner"></span>
            {{ generating ? '正在生成解读…' : '生成或读取 AI 解读' }}
          </button>
          <button v-if="report" class="text-button" type="button" :disabled="!canGenerate" @click="generate(true)">按当前选项重新生成（调用模型）</button>
        </div>
      </div>

      <div class="ai-saved-toolbar">
        <label v-if="savedReviews.length" for="ai-saved-select">已保存的解读</label>
        <select v-if="savedReviews.length" id="ai-saved-select" :value="report ? reviewKey(report) : ''" @change="selectSavedReview">
          <option value="">选择已保存报告</option>
          <option v-for="review in savedReviews" :key="reviewKey(review)" :value="reviewKey(review)">{{ reportProviderLabel(review) }} · {{ formatDate(review.generatedAt) }} · {{ review.focus || '无特别关注' }}</option>
        </select>
        <span v-if="savedLoading" role="status">正在读取已保存解读…</span>
        <button v-if="generating" class="button button--quiet button--small" type="button" @click="cancelGeneration">取消生成</button>
      </div>
      <div v-if="savedError" class="inline-error" role="alert"><p>无法读取已保存解读：{{ savedError }}</p><button class="text-button" type="button" @click="loadSavedReviews">重试读取</button></div>

      <div v-if="generating" class="ai-generating" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <div>
          <strong>AI 正在整理报告</strong>
          <p>正在归纳重点风险、迁移次序与测试覆盖建议，请稍候。</p>
        </div>
      </div>

      <div v-else-if="reviewError" class="ai-review-error" role="alert">
        <div><strong>AI 解读生成失败</strong><p>{{ reviewError }}</p></div>
        <button class="button button--quiet button--small" type="button" :disabled="!canGenerate" @click="generate(false)">重试</button>
      </div>

      <article v-else-if="report" class="ai-report" aria-labelledby="ai-report-headline">
        <header class="ai-report__summary">
          <div class="ai-report__meta">
            <span class="ai-risk-level" :class="`ai-risk-level--${report.overview.riskLevel}`">
              {{ riskLabels[report.overview.riskLevel] }}
            </span>
            <span>{{ reportProviderLabel(report) }}</span>
            <span>{{ formatDate(report.generatedAt) }}</span>
          </div>
          <h3 id="ai-report-headline">{{ report.overview.headline }}</h3>
          <p>{{ report.overview.executiveSummary }}</p>
          <p class="ai-evidence-note">AI 风险等级与建议属于解释，不是规则门禁结论。消费者影响是待验证的推测，不代表已检查真实客户端。</p>
          <p v-if="report.coverage" class="ai-evidence-note">解释输入覆盖 {{ report.coverage.includedFindings }} / {{ report.coverage.totalFindings }} 条变更；{{ report.coverage.omittedFindings }} 条未发送给模型。引用已校验为本次输入中的变更，但不代表每条解释都正确。</p>
          <p v-if="report.focus" class="ai-evidence-note">此报告关注点：{{ report.focus }}</p>
          <div v-if="report.id" class="ai-export-actions">
            <span>已保存，可在历史报告中重开</span>
            <button class="text-button" type="button" :disabled="exporting" @click="exportReview('markdown')">导出 AI 解读 Markdown</button>
            <button class="text-button" type="button" :disabled="exporting" @click="exportReview('json')">导出 AI 解读 JSON</button>
          </div>
          <p v-if="exportError" role="alert">{{ exportError }}</p>
        </header>

        <section class="ai-report__section" aria-labelledby="ai-key-risks-title">
          <div class="ai-report__section-heading">
            <div><h3 id="ai-key-risks-title">重点风险</h3></div>
            <small>{{ report.keyRisks.length }} 项</small>
          </div>
          <div v-if="report.keyRisks.length" class="ai-risk-list">
            <article v-for="risk in report.keyRisks" :key="`${risk.changeId}-${risk.title}`" class="ai-risk-card">
              <header>
                <div><span class="ai-priority" :class="`ai-priority--${risk.priority.toLowerCase()}`">{{ risk.priority }}</span><code>{{ risk.changeId }}</code></div>
                <h4>{{ risk.title }}</h4>
              </header>
              <p>{{ risk.explanation }}</p>
              <div v-if="risk.affectedConsumers.length" class="ai-chip-row" aria-label="可能受影响的消费者（需验证）">
                <span v-for="consumer in risk.affectedConsumers" :key="consumer">{{ consumer }}</span>
              </div>
              <div class="ai-remediation"><strong>建议处置</strong><p>{{ risk.remediation }}</p></div>
            </article>
          </div>
          <p v-else class="ai-empty-copy">模型没有识别出需要单独强调的重点风险，请继续以规则报告为准。</p>
        </section>

        <section class="ai-report__section" aria-labelledby="ai-migration-title">
          <div class="ai-report__section-heading">
            <div><h3 id="ai-migration-title">建议迁移计划</h3></div>
            <small>{{ report.migrationPlan.length }} 步</small>
          </div>
          <ol v-if="report.migrationPlan.length" class="ai-plan-list">
            <li v-for="step in report.migrationPlan" :key="`${step.order}-${step.title}`">
              <span class="ai-plan-order">{{ step.order }}</span>
              <div>
                <h4>{{ step.title }}</h4>
                <ul v-if="step.actions.length">
                  <li v-for="action in step.actions" :key="action">{{ action }}</li>
                </ul>
                <div v-if="step.relatedChangeIds.length" class="ai-related-ids">
                  <span>关联变更</span><code v-for="id in step.relatedChangeIds" :key="id">{{ id }}</code>
                </div>
              </div>
            </li>
          </ol>
          <p v-else class="ai-empty-copy">本次解读没有生成迁移步骤。</p>
        </section>

        <section class="ai-report__section" aria-labelledby="ai-tests-title">
          <div class="ai-report__section-heading">
            <div><h3 id="ai-tests-title">测试建议</h3></div>
            <small>{{ report.testSuggestions.length }} 项</small>
          </div>
          <div v-if="report.testSuggestions.length" class="ai-test-grid">
            <article v-for="suggestion in report.testSuggestions" :key="suggestion.title">
              <span aria-hidden="true">✓</span>
              <div>
                <h4>{{ suggestion.title }}</h4>
                <p>{{ suggestion.details }}</p>
                <div v-if="suggestion.relatedChangeIds.length" class="ai-related-ids">
                  <code v-for="id in suggestion.relatedChangeIds" :key="id">{{ id }}</code>
                </div>
              </div>
            </article>
          </div>
          <p v-else class="ai-empty-copy">本次解读没有生成额外测试建议。</p>
        </section>

        <section v-if="report.caveats.length" class="ai-caveats" aria-labelledby="ai-caveats-title">
          <h3 id="ai-caveats-title">解读局限</h3>
          <ul><li v-for="caveat in report.caveats" :key="caveat">{{ caveat }}</li></ul>
        </section>

        <footer class="ai-report__footer">
          <span>Schema {{ report.schemaVersion }}</span>
          <span>Prompt {{ report.promptVersion }}</span>
          <span v-if="tokenTotal !== undefined">{{ tokenTotal }} tokens</span>
          <strong>AI 生成内容，请结合原始规则结果复核。</strong>
        </footer>
      </article>
    </template>
  </section>
</template>
