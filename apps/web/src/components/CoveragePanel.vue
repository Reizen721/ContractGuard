<script setup lang="ts">
import type { AnalysisCoverage } from '../types'
import { formatSourceLocation } from '../utils'

defineProps<{ coverage?: AnalysisCoverage }>()
</script>

<template>
  <section
    class="coverage-panel"
    :class="{
      'coverage-panel--partial': coverage?.status === 'partial',
      'sr-only': coverage?.status === 'complete' && !coverage?.truncated,
    }"
    aria-labelledby="coverage-title"
  >
    <h3 id="coverage-title" class="sr-only">分析覆盖范围</h3>
    <template v-if="!coverage">
      <p class="sr-only">旧报告未记录覆盖范围。不能根据分数或未发现 breaking 推断已经完整检查。</p>
    </template>
    <template v-else-if="coverage.status === 'complete'">
      <p class="sr-only">在当前已实现的分析范围内，未发现已知覆盖缺口。</p>
    </template>
    <template v-else>
      <p class="sr-only">存在未覆盖或需要人工复核的语义。即使没有 breaking 或评分为 100，也不能视为完整兼容。</p>
      <details v-if="coverage.warnings.length">
        <summary>分析覆盖范围 · {{ coverage.warnings.length }} 项待复核提示</summary>
        <ul class="coverage-warnings">
          <li v-for="(warning, index) in coverage.warnings" :key="`${warning.side}:${warning.code}:${warning.location}:${index}`">
            <strong>{{ warning.side === 'old' ? '基线' : '候选' }} · {{ warning.code }}</strong>
            <p>{{ warning.message }}</p>
            <code>{{ warning.location }}</code>
            <small v-if="warning.source">原文件：{{ formatSourceLocation(warning.source) }}</small>
          </li>
        </ul>
      </details>
      <p v-else>覆盖信息不完整，请使用对应版本重新分析。</p>
    </template>
    <p v-if="coverage?.truncated" class="coverage-truncated">提示数量已达到展示上限，请缩小契约范围后复核。</p>
  </section>
</template>
