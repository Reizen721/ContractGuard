<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectPhase, ProjectTestReport } from '@contractguard/project'
const props = defineProps<{ report: ProjectTestReport }>()
const names: Record<string, string> = { pass: '已执行测试通过', regression: '候选引入测试回归', 'invalid-baseline': '基线测试未通过', inconclusive: '测试证据不足', passed: '通过', failed: '失败', cancelled: '已取消', verified: '已通过项目测试', unverified: '尚未验证', 'not-proposed': '未生成候选补丁' }
const label = (value: string) => names[value] || value
const phases = computed(() => [
  { key: 'baseline', name: '基线', result: props.report.baseline },
  { key: 'candidate', name: '候选', result: props.report.candidate },
  ...(props.report.patched ? [{ key: 'patched', name: '补丁副本', result: props.report.patched }] : []),
] as Array<{ key: string; name: string; result: ProjectPhase }>)
</script>

<template>
  <section class="project-test-evidence" aria-labelledby="project-tests-title">
    <div class="section-heading"><h3 id="project-tests-title">项目已有测试</h3><strong :class="report.status === 'regression' ? 'status-danger' : report.status === 'pass' ? 'status-good' : 'status-warning'">{{ label(report.status) }}</strong></div>
    <p>同一组测试分别在基线、候选及可用的补丁副本中执行。结果范围以列出的测试为准。</p>
    <div class="project-phase-table" role="region" aria-label="各阶段项目测试结果" tabindex="0"><table><thead><tr><th scope="col">阶段</th><th scope="col">结果</th><th scope="col">通过 / 失败 / 跳过</th><th scope="col">退出码</th></tr></thead><tbody><tr v-for="phase in phases" :key="phase.key"><th scope="row">{{ phase.name }}</th><td><span class="phase-status" :data-status="phase.result.status">{{ label(phase.result.status) }}</span></td><td class="phase-counts">{{ phase.result.tests.passed }} / {{ phase.result.tests.failed }} / {{ phase.result.tests.skipped }}</td><td>{{ phase.result.exitCode ?? '—' }}</td></tr></tbody></table></div>
    <p class="project-patch-note"><strong>补丁：{{ label(report.patchStatus) }}</strong><span>补丁验证结果保留在任务中，原始契约风险仍需处理。</span></p>
    <details v-for="phase in phases" :key="`details-${phase.key}`"><summary>{{ phase.name }}执行记录 · {{ phase.result.durationMs }} ms</summary><p v-if="phase.result.reason">{{ phase.result.reason }}</p><pre v-if="phase.result.output">{{ phase.result.output }}</pre><p v-else class="muted">没有保存原始测试输出。</p><p v-if="phase.result.truncated" class="status-warning">输出已截断，请结合测试状态判断。</p></details>
    <details><summary>测试文件与项目快照</summary><p>运行器：{{ report.runner }}</p><ul><li v-for="file in report.testFiles" :key="file"><code>{{ file }}</code></li></ul><code class="project-fingerprint">{{ report.snapshotFingerprint.value }}</code><ul><li v-for="item in report.limitations" :key="item">{{ item }}</li></ul></details>
  </section>
</template>
