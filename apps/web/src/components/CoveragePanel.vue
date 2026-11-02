<script setup lang="ts">
import type { AnalysisCoverage } from '../types'
import { formatSourceLocation } from '../utils'

defineProps<{ coverage?: AnalysisCoverage }>()
</script>

<template>
  <section class="coverage-panel" :class="{ 'coverage-panel--partial': coverage?.status === 'partial' }" aria-labelledby="coverage-title">
    <h3 id="coverage-title">分析覆盖范围</h3>
    <template v-if="!coverage">
      <p>旧报告未记录覆盖范围。不能根据分数或未发现 breaking 推断已经完整检查。</p>
    </template>
    <template v-else-if="coverage.status === 'complete'">
      <p>在当前已实现的分析范围内，未发现已知覆盖缺口。这不是完整 OpenAPI 校验或兼容性证明，实际客户端与业务行为仍需验证。</p>
    </template>
    <template v-else>
      <p>存在未覆盖或需要人工复核的语义。即使没有 breaking 或评分为 100，也不能视为完整兼容。</p>
      <details v-if="coverage.warnings.length">
        <summary>{{ coverage.warnings.length }} 项覆盖提示（展开查看）</summary>
        <ul class="coverage-warnings">
          <li v-for="(warning, index) in coverage.warnings" :key="`${warning.side}:${warning.code}:${warning.location}:${index}`">
            <strong>{{ warning.side === 'old' ? '基线' : '候选' }} · {{ warning.code }}</strong>
            <p>{{ warning.message }}</p>
            <code>{{ warning.location }}</code>
            <small v-if="warning.source">原文件：{{ formatSourceLocation(warning.source) }}</small>
          </li>
        </ul>
      </details>
      <p v-else>覆盖信息不完整，请使用对应版本重新分析并人工确认相关范围。</p>
    </template>
    <p v-if="coverage?.truncated" class="coverage-truncated">提示数量已达到展示上限，未列出的内容不代表已经检查。请缩小契约范围或人工复核。</p>
  </section>
</template>
