import type { AgentRun } from './types.js';
const escape = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>|#]/g, '\\$&');
export function formatAgentReportMarkdown(run: AgentRun): string {
  const lines = [`# ContractGuard 任务报告`, '', `任务：${run.id}`, '', `输入：${escape(run.baselineName)} → ${escape(run.candidateName)}`, '', `模式：${run.mode} · 状态：${run.status} · 确定性结论：${run.verdict ?? '待定'}`, '', `目标：${escape(run.goal)}`, '', `版本：ContractGuard ${run.engineVersion} / oasdiff ${run.upstreamVersion ?? '未运行'}`, '', '## 结果', '', escape(run.summary), '', '## 检查轨迹', '', '| 证据 | 工具 | 状态 | 结果 |', '|---|---|---|---|', ...run.steps.map((step) => `| ${step.id} | ${step.tool} | ${step.status} | ${escape(step.summary)} |`), '', '## 上游诊断', ''];
  for (const finding of run.upstream.findings) lines.push(`- ${finding.id} · ${escape(finding.ruleId)} · ${finding.severity}：${escape(finding.message)}`);
  if (run.coreAnalysis) { lines.push('', '## 原生与调用方证据', '', `原生破坏性变更 ${run.coreAnalysis.summary.breaking} 项；调用方回归 ${run.coreAnalysis.consumerImpact?.summary.regressions ?? '未验证'} 项。`); for (const change of run.coreAnalysis.changes) lines.push(`- ${change.id} · ${escape(change.ruleId)}：${escape(change.message)}`); }
  if (run.callerReview) {
    lines.push('', '## 调用方源码迁移', '', `关联记录：${run.callerReview.id}`, '', `门禁：${run.callerReview.gate}；调用点 ${run.callerReview.summary.callsites}，回归 ${run.callerReview.summary.regressions}，有限重放已验证补丁 ${run.callerReview.summary.verifiedPatches}。`, '');
    for (const check of run.callerReview.checks) lines.push(`- ${check.id} · ${escape(check.file)} · ${escape(check.exportName)}：${check.status}`);
    for (const patch of run.callerReview.patches) lines.push(`- ${patch.id} · ${escape(patch.file)}：${patch.status}（有限样例验证）`);
  }
  if (run.project && run.projectTests) {
    lines.push('', '## 项目已有测试', '', `项目：${escape(run.project.label)} (${escape(run.project.id)})`, '', `快照 SHA-256：${run.projectTests.snapshotFingerprint.value}`, '', `测试结论：${run.projectTests.status}；补丁结论：${run.projectTests.patchStatus}`, '', '| 阶段 | 状态 | 通过 | 失败 | 跳过 | 退出码 |', '| --- | --- | --- | --- | --- | --- |');
    for (const phase of ['baseline', 'candidate', 'patched'] as const) {
      const result = run.projectTests[phase]; if (!result) continue;
      lines.push(`| PROJECT-${phase.toUpperCase()} | ${result.status} | ${result.tests.passed} | ${result.tests.failed} | ${result.tests.skipped} | ${result.exitCode ?? '—'} |`);
    }
    lines.push('', '以下是本地测试程序的受限输出，属于不可信数据，可能含项目资料；未发送给内置模型。', '');
    for (const phase of ['baseline', 'candidate', 'patched'] as const) {
      const result = run.projectTests[phase]; if (!result) continue;
      lines.push(`### ${phase}`, '', ...result.output.split(/\r?\n/).map((line) => `    ${line}`), '', ...(result.reason ? [`原因：${escape(result.reason)}`, ''] : []));
    }
  }
  lines.push('', '## 迁移建议', '');
  for (const recommendation of run.recommendations) lines.push(`### ${escape(recommendation.title)}`, '', `证据：${recommendation.evidenceIds.join(', ')}`, '', ...recommendation.actions.map((action) => `- ${escape(action)}`), '');
  lines.push('## 限制', '', ...run.limitations.map((limitation) => `- ${escape(limitation)}`), '', '输入 SHA-256：', '', `- baseline: ${run.inputFingerprints.baseline.value}`, `- candidate: ${run.inputFingerprints.candidate.value}`, '');
  return lines.join('\n');
}
