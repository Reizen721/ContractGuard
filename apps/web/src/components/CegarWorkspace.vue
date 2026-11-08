<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  downloadCegarReport,
  getCegarRun,
  getCegarStatus,
  listCegarPresets,
  listCegarRuns,
  startCegarRun,
  type CegarAgentMode,
  type CegarPresetItem,
  type CegarRunRecord,
  type CegarRunRequestPayload,
  type CegarRunSummary,
  type CegarStatusInfo,
} from '../cegar-api'
import { formatDate } from '../utils'

const presets = ref<CegarPresetItem[]>([])
const selectedPresetId = ref('')
const status = ref<CegarStatusInfo | null>(null)
const runs = ref<CegarRunSummary[]>([])
const activeRun = ref<CegarRunRecord | null>(null)
const mode = ref<CegarAgentMode>('symbolic')
const maxRounds = ref(4)
const enableAdversarial = ref(true)
const activeSourceFile = ref(0)
const callerSourceJson = ref('')
const isRunning = ref(false)
const loadingInitial = ref(true)
const errorMessage = ref('')

const selectedPreset = computed(() => presets.value.find((p) => p.id === selectedPresetId.value) ?? null)

const editableCallerFiles = ref<Array<{ path: string; content: string }>>([])

function applyPreset(preset: CegarPresetItem): void {
  selectedPresetId.value = preset.id
  editableCallerFiles.value = preset.request.callerFiles.map((f) => ({ ...f }))
  activeSourceFile.value = 0
  callerSourceJson.value = JSON.stringify(
    { baseline: preset.request.baseline, candidate: preset.request.candidate },
    null,
    2,
  )
  errorMessage.value = ''
}

function statusBadgeLabel(impact: CegarRunRecord['callerImpactStatus']): string {
  switch (impact) {
    case 'regression-repaired-verified':
      return '已验证修复'
    case 'unreachable-breaking-safe':
      return '不可达免改'
    case 'compatible-verified':
      return '兼容通过'
    default:
      return '未收敛阻断'
  }
}

function statusBadgeClass(impact: CegarRunRecord['callerImpactStatus']): string {
  if (impact === 'regression-repaired-verified' || impact === 'compatible-verified') return 'cegar-pill--mint'
  if (impact === 'unreachable-breaking-safe') return 'cegar-pill--blue'
  return 'cegar-pill--danger'
}

function compressionPercent(record: CegarRunRecord): number {
  return Math.max(0, Math.round((1 - record.dataflow.metrics.compressionRatio) * 100))
}

function diffLines(unifiedDiff: string): Array<{ kind: 'add' | 'del' | 'meta' | 'ctx'; text: string }> {
  return unifiedDiff
    .trimEnd()
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return { kind: 'meta', text: line }
      if (line.startsWith('+')) return { kind: 'add', text: line }
      if (line.startsWith('-')) return { kind: 'del', text: line }
      return { kind: 'ctx', text: line }
    })
}

async function executeCegar(): Promise<void> {
  if (!selectedPreset.value || isRunning.value) return
  isRunning.value = true
  errorMessage.value = ''
  try {
    let contracts = {
      baseline: selectedPreset.value.request.baseline,
      candidate: selectedPreset.value.request.candidate,
    }
    if (callerSourceJson.value.trim()) {
      const parsed = JSON.parse(callerSourceJson.value) as { baseline?: unknown; candidate?: unknown }
      if (parsed.baseline && parsed.candidate) {
        contracts = { baseline: parsed.baseline, candidate: parsed.candidate }
      }
    }
    const payload: CegarRunRequestPayload = {
      ...selectedPreset.value.request,
      mode: mode.value,
      maxRounds: maxRounds.value,
      enableAdversarialFuzzing: enableAdversarial.value,
      baseline: contracts.baseline,
      candidate: contracts.candidate,
      callerFiles: editableCallerFiles.value,
    }
    const record = await startCegarRun(payload)
    activeRun.value = record
    runs.value = await listCegarRuns()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'CEGAR 执行未完成，请检查输入配置。'
  } finally {
    isRunning.value = false
  }
}

async function selectRunHistory(summary: CegarRunSummary): Promise<void> {
  errorMessage.value = ''
  try {
    activeRun.value = await getCegarRun(summary.id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法读取历史记录。'
  }
}

async function handleExport(format: 'markdown' | 'json'): Promise<void> {
  if (!activeRun.value) return
  try {
    await downloadCegarReport(activeRun.value.id, format)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出报告失败。'
  }
}

onMounted(async () => {
  loadingInitial.value = true
  try {
    const [statusInfo, presetItems, runItems] = await Promise.all([
      getCegarStatus(),
      listCegarPresets(),
      listCegarRuns(),
    ])
    status.value = statusInfo
    presets.value = presetItems
    runs.value = runItems
    if (presetItems[0]) applyPreset(presetItems[0])
    if (runItems[0]) {
      activeRun.value = await getCegarRun(runItems[0].id)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载自修复工作台失败。'
  } finally {
    loadingInitial.value = false
  }
})
</script>

<template>
  <section class="cegar-page" aria-label="神经符号自修复 Agent 工作台">
    <header class="page-heading">
      <div>
        <h1>自修复 Agent</h1>
      </div>
      <div class="hero-actions">
        <button
          class="button button--primary"
          type="button"
          :disabled="isRunning || !selectedPreset"
          @click="executeCegar"
        >
          <span v-if="isRunning" class="spinner"></span>
          {{ isRunning ? '正在验证精化…' : '运行 CEGAR 闭环' }}
        </button>
      </div>
    </header>

    <p v-if="errorMessage" class="report-notice" role="alert">{{ errorMessage }}</p>

    <div class="cegar-layout">
      <!-- Left Rail: Scenarios, Execution Controls, Editable Workspace, History -->
      <aside class="cegar-sidebar">
        <div class="cegar-card">
          <div class="cegar-card__header">
            <h2>基准场景</h2>
            <span class="cegar-tag">{{ presets.length }} 组</span>
          </div>
          <div class="cegar-preset-list" role="listbox" aria-label="选择 CEGAR 演示场景">
            <button
              v-for="preset in presets"
              :key="preset.id"
              type="button"
              class="cegar-preset-item"
              :class="{ active: preset.id === selectedPresetId }"
              @click="applyPreset(preset)"
            >
              <div class="cegar-preset-item__top">
                <span class="cegar-mono-badge">{{ preset.category }}</span>
                <span class="cegar-rounds-hint">
                  {{ preset.expectedRounds === 0 ? '零补丁剪枝' : `${preset.expectedRounds} 轮精化` }}
                </span>
              </div>
              <strong>{{ preset.label }}</strong>
              <p>{{ preset.description }}</p>
            </button>
          </div>
        </div>

        <div class="cegar-card">
          <div class="cegar-card__header">
            <h2>验证器配置</h2>
          </div>
          <div class="cegar-controls">
            <label class="cegar-field">
              <span>合成策略</span>
              <select v-model="mode">
                <option value="symbolic">符号 AST + TypeChecker</option>
                <option value="hybrid">混合模式 (AST + LLM)</option>
                <option value="llm" :disabled="!status?.llm.available">
                  LLM 闭环 {{ status?.llm.available ? '' : '(未配置)' }}
                </option>
              </select>
            </label>

            <label class="cegar-field">
              <span>轮数上限</span>
              <select v-model.number="maxRounds">
                <option :value="1">1 轮 (单轮对照)</option>
                <option :value="2">2 轮</option>
                <option :value="4">4 轮 (标准)</option>
              </select>
            </label>

            <label class="cegar-toggle">
              <input v-model="enableAdversarial" type="checkbox" />
              <span>启用对抗见证 Fuzzing</span>
            </label>
          </div>

          <details class="cegar-source-drawer">
            <summary>查看 / 编辑调用方源码 ({{ editableCallerFiles.length }} 个文件)</summary>
            <div v-if="editableCallerFiles.length" class="cegar-file-tabs">
              <button
                v-for="(file, index) in editableCallerFiles"
                :key="file.path"
                type="button"
                :class="{ active: index === activeSourceFile }"
                @click="activeSourceFile = index"
              >
                {{ file.path.replace(/^src\//, '') }}
              </button>
            </div>
            <textarea
              v-if="editableCallerFiles[activeSourceFile]"
              v-model="editableCallerFiles[activeSourceFile]!.content"
              class="cegar-code-editor"
              spellcheck="false"
              aria-label="编辑调用方 TypeScript 源码"
            ></textarea>
          </details>
        </div>

        <div v-if="runs.length" class="cegar-card">
          <div class="cegar-card__header">
            <h2>最近记录</h2>
          </div>
          <ul class="cegar-history-list">
            <li v-for="item in runs.slice(0, 6)" :key="item.id">
              <button
                type="button"
                :class="{ active: activeRun?.id === item.id }"
                @click="selectRunHistory(item)"
              >
                <div>
                  <strong>{{ item.title }}</strong>
                  <small>{{ formatDate(item.createdAt) }} · {{ item.rounds }} 轮</small>
                </div>
                <span class="cegar-pill" :class="statusBadgeClass(item.callerImpactStatus)">
                  {{ statusBadgeLabel(item.callerImpactStatus) }}
                </span>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <!-- Main Canvas: CEGAR Trajectory, Witnesses, Reachability, Verified Diff -->
      <div class="cegar-canvas">
        <div v-if="loadingInitial" class="cegar-empty-state">
          <h2>正在连接自修复引擎…</h2>
        </div>

        <div v-else-if="!activeRun && !isRunning" class="cegar-empty-state">
          <h2>四门确定性沙箱驱动的多轮自修复</h2>
          <p>选择左侧场景并点击「运行 CEGAR 闭环」，查看契约对齐、程序切片与反例收敛过程。</p>
        </div>

        <template v-else-if="activeRun">
          <!-- Top Summary Banner -->
          <div class="cegar-hero-card">
            <div class="cegar-hero-card__top">
              <div>
                <div class="cegar-badges-row">
                  <span class="cegar-pill" :class="statusBadgeClass(activeRun.callerImpactStatus)">
                    {{ statusBadgeLabel(activeRun.callerImpactStatus) }}
                  </span>
                  <span class="cegar-mono-badge">原始契约门禁: {{ activeRun.releaseGate.toUpperCase() }}</span>
                  <span class="cegar-mono-badge">{{ activeRun.durationMs }} ms</span>
                </div>
                <h2>{{ activeRun.title }}</h2>
                <p class="cegar-summary-text">{{ activeRun.summary }}</p>
              </div>
              <div class="cegar-export-actions">
                <button class="button button--quiet" type="button" @click="handleExport('markdown')">导出 MD</button>
                <button class="button button--quiet" type="button" @click="handleExport('json')">JSON</button>
              </div>
            </div>

            <div class="cegar-metrics-grid">
              <div class="cegar-metric">
                <span>精化收敛轮数</span>
                <strong>{{ activeRun.rounds.length }} 轮</strong>
              </div>
              <div class="cegar-metric">
                <span>程序切片降噪</span>
                <strong>{{ compressionPercent(activeRun) }}%</strong>
              </div>
              <div class="cegar-metric">
                <span>差分对抗见证</span>
                <strong>{{ activeRun.witnesses.adversarialCount }} 项</strong>
              </div>
              <div class="cegar-metric">
                <span>已验证补丁文件</span>
                <strong>{{ activeRun.finalPatches.length }} 个</strong>
              </div>
            </div>
          </div>

          <!-- Schema Alignment Hypotheses & Differential Witnesses -->
          <div class="cegar-two-col">
            <section class="cegar-card">
              <div class="cegar-card__header">
                <h3>自动契约对齐假设</h3>
                <span class="cegar-tag">{{ activeRun.alignment.hypotheses.length }} 项</span>
              </div>
              <ul v-if="activeRun.alignment.hypotheses.length" class="cegar-hyp-list">
                <li v-for="hyp in activeRun.alignment.hypotheses" :key="hyp.id">
                  <div class="cegar-hyp-row">
                    <span class="cegar-mono-badge">{{ hyp.kind }}</span>
                    <code>{{ hyp.fromPath || '(新增)' }} → {{ hyp.toPath || '(移除)' }}</code>
                    <b>{{ Math.round(hyp.confidence * 100) }}%</b>
                  </div>
                </li>
              </ul>
              <p v-else class="cegar-muted">无结构重命名或类型漂移假设（纯删除或向后兼容变更）。</p>
            </section>

            <section class="cegar-card">
              <div class="cegar-card__header">
                <h3>差分边界见证集</h3>
                <span class="cegar-tag">{{ activeRun.witnesses.adversarialCount }} 组载荷</span>
              </div>
              <ul v-if="activeRun.witnesses.adversarialCount > 0" class="cegar-witness-list">
                <template v-for="suite in activeRun.witnesses.suites" :key="suite.operation.path">
                  <li v-for="wit in suite.adversarial.slice(0, 5)" :key="wit.id">
                    <span class="cegar-mono-badge">{{ wit.id }}</span>
                    <span>{{ wit.description }}</span>
                  </li>
                </template>
              </ul>
              <p v-else class="cegar-muted">候选契约未引入新的可空、可选或扩展枚举边界。</p>
            </section>
          </div>

          <!-- Multi-Round CEGAR Trajectory -->
          <section v-if="activeRun.rounds.length" class="cegar-card">
            <div class="cegar-card__header">
              <h3>CEGAR 反例精化轨迹</h3>
              <span class="cegar-tag">{{ activeRun.rounds.length }} 轮闭环</span>
            </div>

            <div class="cegar-timeline">
              <article
                v-for="round in activeRun.rounds"
                :key="round.round"
                class="cegar-round"
                :class="{ 'cegar-round--verified': round.verification.verified, 'cegar-round--cex': !round.verification.verified }"
              >
                <div class="cegar-round__head">
                  <div class="cegar-round__title">
                    <span class="cegar-round-num">Round {{ round.round }}</span>
                    <strong>{{ round.actionSummary }}</strong>
                  </div>
                  <span
                    class="cegar-pill"
                    :class="round.verification.verified ? 'cegar-pill--mint' : 'cegar-pill--amber'"
                  >
                    {{ round.verification.verified ? '全部验证门通过' : `捕获 ${round.counterexamples.length} 项反例` }}
                  </span>
                </div>

                <div class="cegar-gates-row">
                  <span class="cegar-gate" :class="{ pass: round.verification.compilerClean, fail: !round.verification.compilerClean }">
                    1. TypeChecker {{ round.verification.compilerClean ? '✓' : '✗' }}
                  </span>
                  <span class="cegar-gate" :class="{ pass: round.verification.nominalPassed, fail: !round.verification.nominalPassed }">
                    2. 常规单测 {{ round.verification.nominalPassed ? '✓' : '✗' }}
                  </span>
                  <span class="cegar-gate" :class="{ pass: round.verification.requestContractPassed, fail: !round.verification.requestContractPassed }">
                    3. 请求契约 {{ round.verification.requestContractPassed ? '✓' : '✗' }}
                  </span>
                  <span
                    class="cegar-gate"
                    :class="{
                      pass: round.verification.adversarialPassed === round.verification.adversarialTotal,
                      fail: round.verification.adversarialPassed < round.verification.adversarialTotal,
                    }"
                  >
                    4. 对抗见证 {{ round.verification.adversarialPassed }}/{{ round.verification.adversarialTotal }}
                  </span>
                </div>

                <div v-if="round.counterexamples.length" class="cegar-cex-box">
                  <div v-for="cex in round.counterexamples" :key="cex.id" class="cegar-cex-item">
                    <span class="cegar-mono-badge cegar-mono-badge--warn">
                      {{ cex.witnessId || cex.code || cex.kind }}
                    </span>
                    <code>{{ cex.file ? `${cex.file}:${cex.line ?? 1}` : cex.kind }}</code>
                    <span>{{ cex.message }}</span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <!-- Verified Unified Diffs -->
          <section v-if="activeRun.finalPatches.length" class="cegar-card">
            <div class="cegar-card__header">
              <h3>已验证源码补丁 (Unified Diff)</h3>
              <span class="cegar-tag">{{ activeRun.finalPatches.length }} 个文件</span>
            </div>

            <div v-for="patch in activeRun.finalPatches" :key="patch.file" class="cegar-diff-block">
              <div class="cegar-diff-header">
                <code>{{ patch.file }}</code>
                <span>SHA-256 {{ patch.sourceSha256.slice(0, 8) }} → {{ patch.patchedSha256.slice(0, 8) }}</span>
              </div>
              <pre class="cegar-diff-pre"><span
                v-for="(line, idx) in diffLines(patch.unifiedDiff)"
                :key="idx"
                :class="`cegar-diff-line cegar-diff-line--${line.kind}`"
              >{{ line.text }}
</span></pre>
            </div>
          </section>
        </template>
      </div>
    </div>
  </section>
</template>
