import type { AgentInput } from './agent-types'

/** Import an explicit V1.7 migration bundle; the API performs authoritative validation. */
export function importAgentMigration(text: string): AgentInput {
  if (new TextEncoder().encode(text).length > 12 * 1024 * 1024) throw new Error('迁移材料超过 12 MiB，请缩小范围。')
  let value: Record<string, unknown>
  try { value = JSON.parse(text) as Record<string, unknown> } catch { throw new Error('迁移材料不是有效 JSON，请检查文件格式。') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !value.baseline || !value.candidate || !Array.isArray(value.files) || !Array.isArray(value.scenarios)) throw new Error('请选择包含新旧契约、files 和 scenarios 的调用方迁移输入包。')
  return {
    baseline: value.baseline as AgentInput['baseline'], candidate: value.candidate as AgentInput['candidate'],
    baselineName: '迁移材料 · 基线', candidateName: '迁移材料 · 候选',
    caller: { files: value.files as NonNullable<AgentInput['caller']>['files'], scenarios: value.scenarios as NonNullable<AgentInput['caller']>['scenarios'], ...(value.fieldRenames === undefined ? {} : { fieldRenames: value.fieldRenames as NonNullable<AgentInput['caller']>['fieldRenames'] }) },
  }
}
