<script setup lang="ts">
import type { AnalysisRecord } from '../types'
defineProps<{ analysis: AnalysisRecord }>()
</script>
<template>
  <section class="analysis-summary" aria-label="分析摘要">
    <div class="analysis-verdict" :class="analysis.compatible ? 'is-pass' : 'is-fail'">
      <h3>{{ analysis.compatible ? '未发现确定性破坏' : '发现阻断性变更' }}</h3>
      <p>规则判定 · {{ analysis.summary.potentiallyBreaking ? '仍有潜在风险需要复核。' : '' }}未覆盖语义与实际调用方行为仍需验证。</p>
    </div>
    <dl class="analysis-counts">
      <div><dt>破坏性变更</dt><dd class="status-danger">{{ analysis.summary.breaking }}</dd></div>
      <div><dt>潜在风险</dt><dd class="status-warning">{{ analysis.summary.potentiallyBreaking }}</dd></div>
      <div><dt>兼容变更</dt><dd>{{ analysis.summary.nonBreaking }}</dd></div>
      <div><dt>信息提示</dt><dd>{{ analysis.summary.info }}</dd></div>
    </dl>
    <p class="score-note">风险排序参考分 <strong>{{ analysis.score }}/100</strong>，不代表兼容性保证。</p>
  </section>
</template>
