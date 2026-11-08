<script setup lang="ts">
import type { ConsumerCheck, ConsumerImpactReport, EvidenceValidation } from '../types'

defineProps<{ report?: ConsumerImpactReport; error?: string }>()
const gateLabels = { blocked: '发现样例回归', review: '需要复核', pass: '样例范围内通过' }
const checkLabels: Record<ConsumerCheck['status'], string> = {
  regression: '回归', 'invalid-baseline': '基线样例无效', inconclusive: '证据不足', pass: '样例通过',
}
const validationLabels: Record<EvidenceValidation['status'], string> = { valid: '符合已验证约束', invalid: '不符合约束', unknown: '未能完整验证' }
function needsReview(checks: ConsumerCheck[]): boolean { return checks.some((check) => check.status !== 'pass') }
</script>

<template>
  <section class="consumer-impact" :class="{ 'sr-only': !report && !error }" aria-labelledby="consumer-impact-title">
    <div class="consumer-impact__heading">
      <h3 id="consumer-impact-title">调用方影响验证</h3>
      <strong v-if="report" class="consumer-status" :class="`consumer-status--${report.gate}`">{{ gateLabels[report.gate] }}</strong>
    </div>
    <p v-if="error" class="consumer-input__error" role="alert">{{ error }}</p>
    <p v-else-if="!report" class="sr-only">此报告未运行调用方样例验证。不能据此判断哪些应用受到影响；在新分析中附加样例后可验证。</p>
    <template v-else>
      <p class="consumer-impact__scope">{{ report.summary.consumers }} 个调用方 · {{ report.summary.interactions }} 个交互 · {{ report.summary.checks }} 项检查<span class="sr-only">。依据用户提交的样例进行离线验证，不代表完整调用流量或实际服务测试。</span></p>
      <dl class="consumer-counts">
        <div><dt>回归</dt><dd>{{ report.summary.regressions }}</dd></div>
        <div><dt>样例通过</dt><dd>{{ report.summary.passed }}</dd></div>
        <div><dt>基线无效</dt><dd>{{ report.summary.invalidBaselines }}</dd></div>
        <div><dt>证据不足</dt><dd>{{ report.summary.inconclusive }}</dd></div>
      </dl>
      <p v-if="report.unmappedChangeIds.length" class="consumer-unmapped">{{ report.unmappedChangeIds.length }} 项风险变更尚未关联调用方样例：<code>{{ report.unmappedChangeIds.join(', ') }}</code></p>
      <div class="consumer-list">
        <details v-for="consumer in report.consumers" :key="consumer.id" :open="needsReview(consumer.checks)" class="consumer-entry">
          <summary>
            <strong>{{ consumer.name }}</strong>
            <span>{{ consumer.criticality === 'critical' ? '关键调用方' : '常规调用方' }} · {{ consumer.owner || '未指定负责人' }} · {{ consumer.checks.length }} 项检查</span>
          </summary>
          <ol class="consumer-checks">
            <li v-for="check in consumer.checks" :key="check.id">
              <div class="consumer-checks__heading"><strong>{{ check.name }}</strong><span class="consumer-status" :class="`consumer-status--${check.status}`">{{ checkLabels[check.status] }}</span></div>
              <p><code>{{ check.method.toUpperCase() }} {{ check.path }}</code> · {{ check.kind === 'request' ? '请求样例' : '响应与调用方约束' }} · <code>{{ check.id }}</code></p>
              <p>{{ check.note }}</p>
              <div class="consumer-evidence-grid">
                <div v-for="side in (['baseline', 'candidate'] as const)" :key="side">
                  <h4>{{ side === 'baseline' ? '基线' : '候选' }}：{{ validationLabels[check[side].status] }}</h4>
                  <ul v-if="check[side].issues.length">
                    <li v-for="(issue, index) in check[side].issues" :key="index"><code>{{ issue.code }} · {{ issue.path }}</code><p>{{ issue.message }}</p></li>
                  </ul>
                  <p v-if="check[side].truncated">问题列表已截断，仍需复核未展示的内容。</p>
                </div>
              </div>
              <p v-if="check.relatedChangeIds.length" class="consumer-context">关联契约变更：<code>{{ check.relatedChangeIds.join(', ') }}</code></p>
            </li>
          </ol>
        </details>
      </div>
      <details v-if="report.migrationTasks.length" class="consumer-tasks" open>
        <summary>迁移与补证清单（{{ report.migrationTasks.length }} 项）</summary>
        <ol>
          <li v-for="task in report.migrationTasks" :key="task.id">
            <strong>{{ task.priority === 'high' ? '优先处理' : '安排处理' }} · {{ task.owner || '待分配负责人' }}</strong>
            <p>{{ task.action }}</p>
            <p>完成条件：{{ task.verification }}</p>
            <small>调用方 <code>{{ task.consumerId }}</code> · 检查 <code>{{ task.checkIds.join(', ') }}</code></small>
          </li>
        </ol>
      </details>
      <details class="consumer-limitations">
        <summary>验证范围与样例指纹</summary>
        <ul><li v-for="(item, index) in report.limitations" :key="index">{{ item }}</li></ul>
        <p>样例 SHA-256：<code>{{ report.fingerprint.value }}</code></p>
      </details>
    </template>
  </section>
</template>
