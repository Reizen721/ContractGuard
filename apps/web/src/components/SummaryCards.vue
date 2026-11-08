<script setup lang="ts">
import type { AnalysisRecord } from '../types'
defineProps<{ analysis: AnalysisRecord }>()
</script>
<template>
  <section class="analysis-summary" aria-label="分析摘要">
    <div class="analysis-verdict" :class="analysis.compatible ? 'is-pass' : 'is-fail'">
      <h3>{{ analysis.compatible ? '未发现确定性破坏' : '发现阻断性变更' }}</h3>
      <p class="score-note">兼容参考分 <strong>{{ analysis.score }}</strong> / 100</p>
    </div>
    <dl class="analysis-counts">
      <div><dt>破坏性变更</dt><dd class="status-danger">{{ analysis.summary.breaking }}</dd></div>
      <div><dt>潜在风险</dt><dd class="status-warning">{{ analysis.summary.potentiallyBreaking }}</dd></div>
      <div><dt>兼容变更</dt><dd>{{ analysis.summary.nonBreaking }}</dd></div>
      <div><dt>信息提示</dt><dd>{{ analysis.summary.info }}</dd></div>
    </dl>
  </section>
</template>
