<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createCallerReview, downloadCallerReview, getCallerReview, listCallerReviews, type CallerRecord, type CallerSummary } from '../caller-api'
import example from '../../../../fixtures/caller-impact/input.json'
const props = defineProps<{ initialReviewId?: string }>()

const input = ref('')
const active = ref<CallerRecord | null>(null)
const history = ref<CallerSummary[]>([])
const error = ref('')
const historyError = ref('')
const pending = ref(false)
const historyLoading = ref(false)
const importing = ref(false)
const exporting = ref(false)
const mode = ref<'input' | 'report'>('input')
let sequence = 0
let historySequence = 0
let importSequence = 0
let controller: AbortController | undefined
let historyController: AbortController | undefined
const report = computed(() => active.value?.report)
const labels: Record<string, string> = { pass: '本次证据通过', blocked: '存在阻断风险', review: '需要人工复核', regression: '候选版本回归', 'invalid-baseline': '基线不满足预期', inconclusive: '无法确定', resolved: '已定位', unknown: '未解析', verified: '已在副本验证', failed: '验证失败', unverified: '未完成验证', passed: '符合预期', unsupported: '超出支持范围' }
const label = (value: string) => labels[value] || value
const checkNotes: Record<string, string> = { pass: '提交的基线与候选响应均满足契约，并在本次重放中得到明确要求的输出。', regression: '基线符合预期；候选在相同预期下输出不匹配，或出现受支持的运行错误。', 'invalid-baseline': '基线样例或重放不满足要求，不能据此判断为升级引入的回归。', inconclusive: '源码、契约或样例超出支持范围，或无法确认对应调用；本次不作通过判断。' }
function limitation(text: string) {
  if (text.startsWith('Evidence is bounded TypeScript')) return '本次证据来自有限 TypeScript 语法的样例重放，不代表 Node.js 全程序执行、真实 HTTP 流量或完整项目测试。'
  if (text.startsWith('Only named async exported')) return '仅支持已命名导出的异步函数、单个字面量 fetch/axios 调用、const 绑定及部分表达式和分支语法；不支持的逻辑保留为未知。'
  if (text.startsWith('Request bodies, authentication')) return '请求体、鉴权、请求头、序列化、重试、真实网络、模块初始化及外部依赖均未执行或验证。'
  if (text.startsWith('Field usages reflect')) return '字段位置来自样例实际经过的代码路径；未经过的分支和未提交的文件不在证据范围内。'
  if (text.startsWith('Related change IDs')) return '关联规则编号提供接口级背景，并不表示每一条规则都是该调用方失败的直接原因。'
  if (text.startsWith('Renames are explicitly')) return '字段改名来自明确提供的映射。补丁只修改内存副本；通过表示该文件全部已提交场景通过，原始契约风险仍然保留。'
  return text
}
function outcome(value: { status: string; value?: unknown; error?: string }) { return value.error || (value.value === undefined ? label(value.status) : JSON.stringify(value.value)) }
function stopPending() { sequence++; controller?.abort(); pending.value = false }
function editInput() { stopPending(); importSequence++; importing.value = false; error.value = ''; active.value = null; mode.value = 'input' }
function loadExample() { editInput(); input.value = JSON.stringify(example, null, 2) }
async function importInput(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  editInput()
  const current = ++importSequence
  importing.value = true
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error('输入文件超过 12 MiB，请缩小提交范围。')
    const content = await file.text()
    if (current !== importSequence) return
    JSON.parse(content)
    input.value = content
  } catch (reason) { if (current === importSequence) error.value = reason instanceof Error ? reason.message : '无法读取输入文件。' }
  finally { if (current === importSequence) importing.value = false }
}
async function refreshHistory() {
  const current = ++historySequence
  historyController?.abort()
  historyController = new AbortController()
  historyLoading.value = true
  historyError.value = ''
  try { const entries = await listCallerReviews(historyController.signal); if (current === historySequence) history.value = entries }
  catch (reason) { if (current === historySequence) historyError.value = reason instanceof Error ? reason.message : '历史读取失败。' }
  finally { if (current === historySequence) historyLoading.value = false }
}
async function submit() {
  stopPending()
  const current = sequence
  active.value = null
  error.value = ''
  try {
    if (new TextEncoder().encode(input.value).length > 12 * 1024 * 1024) throw new Error('输入超过 12 MiB，请缩小提交范围。')
    const body: unknown = JSON.parse(input.value)
    pending.value = true
    controller = new AbortController()
    const saved = await createCallerReview(body, controller.signal)
    if (current !== sequence) return
    active.value = saved
    mode.value = 'report'
    await refreshHistory()
  } catch (reason) { if (current === sequence) error.value = reason instanceof Error ? reason.message : '审查失败，请检查输入。' }
  finally { if (current === sequence) pending.value = false }
}
async function openHistory(id: string) {
  stopPending()
  importSequence++
  importing.value = false
  const current = sequence
  controller = new AbortController()
  pending.value = true
  error.value = ''
  active.value = null
  mode.value = 'report'
  try { const saved = await getCallerReview(id, controller.signal); if (current === sequence) active.value = saved }
  catch (reason) { if (current === sequence) error.value = reason instanceof Error ? reason.message : '报告读取失败。' }
  finally { if (current === sequence) pending.value = false }
}
async function download(format: 'json' | 'markdown') {
  if (!active.value) return
  exporting.value = true
  error.value = ''
  try { await downloadCallerReview(active.value.id, format) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '下载失败。' }
  finally { exporting.value = false }
}
onMounted(() => { void refreshHistory(); if (props.initialReviewId) void openHistory(props.initialReviewId) })
onBeforeUnmount(() => { stopPending(); historySequence++; importSequence++; historyController?.abort() })
</script>

<template>
  <section class="caller-workspace" aria-labelledby="caller-title" :aria-busy="pending">
    <header class="page-heading">
      <div><h1 id="caller-title">调用方迁移验证</h1><p>定位代码中的 API 调用，对照响应样例重放函数，并检查候选补丁。</p></div>
      <div class="hero-actions"><button class="button button--quiet" type="button" :disabled="pending" @click="loadExample">载入迁移示例</button><button v-if="mode === 'report'" class="button button--quiet" type="button" @click="editInput">新建审查</button></div>
    </header>
    <p class="caller-boundary">当前支持有限的 TypeScript 函数逻辑重放。未解析的调用会单独列出；补丁在副本中验证，不会修改项目文件。</p>
    <div v-if="error" class="agent-error" role="alert">{{ error }}</div>
    <form v-if="mode === 'input'" class="caller-input" @submit.prevent="submit">
      <div class="section-heading"><h2>提交契约、源码与测试样例</h2><label class="caller-file">导入 JSON 文件<input type="file" accept=".json,application/json" :disabled="pending || importing" @change="importInput"></label></div>
      <label for="caller-input-json">审查输入 JSON</label>
      <textarea id="caller-input-json" v-model="input" spellcheck="false" rows="10" :disabled="pending || importing" aria-describedby="caller-input-help" @input="error = ''"></textarea>
      <p id="caller-input-help">包含新旧契约、源文件内容、响应样例与预期输出。字段改名需明确提供映射。可先载入示例查看格式；MCP 和 CLI 使用相同的输入与记录。</p>
      <button class="button button--primary" type="submit" :disabled="pending || importing || !input.trim()">{{ importing ? '正在读取文件…' : pending ? '正在定位与重放…' : '运行调用方审查' }}</button>
    </form>
    <div class="caller-layout">
      <aside class="caller-history" aria-label="调用方审查历史">
        <div class="section-heading"><h2>审查历史</h2><button class="text-button" type="button" :disabled="historyLoading" @click="refreshHistory">刷新</button></div>
        <p v-if="historyLoading" role="status">正在读取历史…</p>
        <p v-if="historyError" role="alert">{{ historyError }}</p>
        <p v-else-if="!historyLoading && !history.length">完成审查后，可在这里继续查看证据和补丁。</p>
        <ol><li v-for="item in history" :key="item.id"><button type="button" :aria-current="active?.id === item.id ? 'true' : undefined" @click="openHistory(item.id)"><strong>{{ label(item.gate) }}</strong><span>{{ item.summary.files }} 个文件 · {{ item.summary.regressions }} 项回归</span><time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time></button></li></ol>
      </aside>
      <article v-if="report && active" class="caller-report" aria-label="调用方审查报告">
        <header class="caller-verdict" :data-verdict="report.gate"><h2>{{ label(report.gate) }}</h2><p>{{ report.summary.callsites }} 个调用点 · {{ report.summary.regressions }} 项回归 · {{ report.summary.inconclusive }} 项无法确定 · {{ report.summary.verifiedPatches }} 份补丁已在副本验证</p><p>原始风险结论会保留；补丁验证通过不等于这次发布已通过。</p><small>记录 <code>{{ active.id }}</code></small></header>
        <section aria-labelledby="caller-locations"><h3 id="caller-locations">代码位置与关联证据</h3><p v-if="!report.callsites.length">没有定位到受支持的调用点，请查看未覆盖范围。</p><article v-for="site in report.callsites" :key="site.id" class="caller-row"><header><code>{{ site.file }}:{{ site.line }}:{{ site.column }}</code><span>{{ label(site.status) }}</span></header><p><code>{{ site.exportName }} · {{ site.method || '?' }} {{ site.path || '动态路径' }}</code></p><p v-if="site.fields.length">字段与行列：<code>{{ site.fields.map(field => `${field.path} (${field.line}:${field.column})`).join(', ') }}</code></p><p v-if="site.reason">{{ site.reason }}</p><small>规则证据：{{ site.relatedChangeIds.join(', ') || '无关联规则；仍需查看重放结果' }}</small></article><details v-if="report.contractAnalysis.changes?.length"><summary>查看关联契约规则结果</summary><article v-for="change in report.contractAnalysis.changes" :key="change.id" class="caller-row"><header><code>{{ change.id }} · {{ change.ruleId }}</code><span>{{ change.severity }}</span></header><p>{{ change.message }}</p><code>{{ change.location }}</code></article></details></section>
        <section aria-labelledby="caller-replay"><h3 id="caller-replay">基线与候选重放</h3><article v-for="check in report.checks" :key="check.id" class="caller-row"><header><strong>{{ check.scenarioId }}</strong><span>{{ label(check.status) }}</span></header><p><code>{{ check.file }} · {{ check.exportName }}</code></p><dl class="caller-outcomes"><div><dt>基线 · {{ label(check.baseline.status) }}</dt><dd><pre>{{ outcome(check.baseline) }}</pre></dd></div><div><dt>候选 · {{ label(check.candidate.status) }}</dt><dd><pre>{{ outcome(check.candidate) }}</pre></dd></div></dl><p>{{ checkNotes[check.status] || check.note }}</p></article><p v-if="!report.checks.length">没有提交可重放的场景，不能据此判断调用方安全。</p></section>
        <section aria-labelledby="caller-patches"><h3 id="caller-patches">候选补丁</h3><p v-if="!report.patches.length">没有生成补丁。支持的字段改名需要明确映射与可验证场景。</p><article v-for="patch in report.patches" :key="patch.id" class="caller-row"><header><code>{{ patch.file }}</code><strong>{{ label(patch.verification.status) }}</strong></header><p>{{ patch.verification.status === 'verified' ? '原始回归已复现；该文件的基线和补丁后的全部已提交场景均符合预期。' : '该补丁尚未满足完整的样例验证条件，请查看详情。' }}</p><details><summary>查看补丁与验证结果</summary><pre class="caller-diff">{{ patch.unifiedDiff }}</pre><ul><li v-for="result in patch.verification.results" :key="result.scenarioId">{{ result.scenarioId }}：{{ label(result.outcome.status) }} — {{ outcome(result.outcome) }}</li></ul><p>{{ patch.verification.reason }}</p><p class="caller-fingerprint">原始文件 SHA-256：<code>{{ patch.sourceSha256 }}</code></p></details></article></section>
        <section class="caller-limitations"><h3>未覆盖范围与判断边界</h3><ul><li v-for="item in report.limitations" :key="item">{{ limitation(item) }}</li></ul></section>
        <footer class="agent-export"><span>报告可能包含源码片段与观测结果，分享前请检查内容。</span><button class="button button--quiet" type="button" :disabled="exporting" @click="download('markdown')">导出 Markdown</button><button class="button button--quiet" type="button" :disabled="exporting" @click="download('json')">导出 JSON</button></footer>
      </article>
      <div v-else class="caller-empty"><p v-if="pending" role="status">正在读取与检查证据…</p><template v-else><h2>从具体调用方判断迁移影响</h2><p>使用上方示例开始，或打开 Agent 已保存的审查记录。每项结论都可以追溯到源文件、样例和重放结果。</p><p>此处运行受限语法解释，不连接业务接口，也不运行项目的安装脚本或测试命令。</p></template></div>
    </div>
  </section>
</template>
