import type { ConsumerCheck, ConsumerImpactReport, EvidenceValidation } from './types.js'

export const CONSUMER_EVIDENCE_MAX_BYTES = 1024 * 1024

export function parseConsumerEvidence(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  if (text.length > CONSUMER_EVIDENCE_MAX_BYTES || new TextEncoder().encode(text).byteLength > CONSUMER_EVIDENCE_MAX_BYTES) {
    throw new Error('调用方样例超过 1 MiB，请拆分后重新导入。')
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('调用方样例不是有效的 JSON。请检查引号、逗号和括号，或清空此可选输入。') }
  if (!record(value)) throw new Error('调用方样例必须是 JSON 对象，不能是数组或其他值。')
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 8000 }
function strings(value: unknown, maximum = 1000): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(text)
}
function validation(value: unknown): value is EvidenceValidation {
  return record(value) && ['valid', 'invalid', 'unknown'].includes(String(value.status))
    && typeof value.truncated === 'boolean' && Array.isArray(value.issues) && value.issues.length <= 100
    && value.issues.every((issue) => record(issue) && text(issue.code) && text(issue.path) && text(issue.message))
}
function check(value: unknown): value is ConsumerCheck {
  if (!record(value) || !text(value.id) || !text(value.interactionId) || !text(value.name)
    || !text(value.method) || !text(value.path) || !text(value.note)
    || !['request', 'response'].includes(String(value.kind))
    || !['pass', 'regression', 'invalid-baseline', 'inconclusive'].includes(String(value.status))
    || !validation(value.baseline) || !validation(value.candidate) || !strings(value.relatedChangeIds)) return false
  if (value.status === 'pass' && (value.baseline.status !== 'valid' || value.candidate.status !== 'valid'
    || value.baseline.truncated || value.candidate.truncated)) return false
  if (value.status === 'regression' && (value.baseline.status !== 'valid' || value.candidate.status !== 'invalid')) return false
  return true
}

/** Invalid persisted/API data is omitted with an explicit UI error, never coerced to a pass. */
export function normalizeConsumerImpact(value: unknown): ConsumerImpactReport | undefined {
  if (!record(value) || value.schemaVersion !== 1 || value.evidenceKind !== 'supplied-examples'
    || !record(value.fingerprint) || value.fingerprint.algorithm !== 'sha256'
    || typeof value.fingerprint.value !== 'string' || !/^[a-f0-9]{64}$/i.test(value.fingerprint.value)
    || !['pass', 'review', 'blocked'].includes(String(value.gate))
    || !Array.isArray(value.consumers) || !value.consumers.length || value.consumers.length > 50
    || !strings(value.unmappedChangeIds) || !strings(value.limitations, 100)
    || !Array.isArray(value.migrationTasks) || value.migrationTasks.length > 400 || !record(value.summary)) return undefined
  const checks: ConsumerCheck[] = []
  const consumerIds = new Set<string>()
  const checkIds = new Set<string>()
  let interactions = 0
  for (const consumer of value.consumers) {
    if (!record(consumer) || !text(consumer.id) || consumerIds.has(consumer.id) || !text(consumer.name)
      || (consumer.owner !== undefined && !text(consumer.owner))
      || !['critical', 'standard'].includes(String(consumer.criticality))
      || !Array.isArray(consumer.checks) || !consumer.checks.length || !consumer.checks.every(check)) return undefined
    consumerIds.add(consumer.id)
    interactions += new Set(consumer.checks.map((item) => item.interactionId)).size
    for (const item of consumer.checks) {
      if (checkIds.has(item.id)) return undefined
      checkIds.add(item.id)
      checks.push(item)
    }
  }
  if (checks.length > 400 || interactions > 200) return undefined
  const summary = { consumers: consumerIds.size, interactions, checks: checks.length,
    passed: checks.filter((item) => item.status === 'pass').length,
    regressions: checks.filter((item) => item.status === 'regression').length,
    invalidBaselines: checks.filter((item) => item.status === 'invalid-baseline').length,
    inconclusive: checks.filter((item) => item.status === 'inconclusive').length }
  for (const key of Object.keys(summary) as Array<keyof typeof summary>) if (value.summary[key] !== summary[key]) return undefined
  if (summary.regressions > 0 && value.gate !== 'blocked') return undefined
  if (value.gate === 'pass' && (summary.invalidBaselines + summary.inconclusive > 0 || value.unmappedChangeIds.length > 0)) return undefined
  for (const task of value.migrationTasks) {
    if (!record(task) || !text(task.id) || !text(task.consumerId) || !consumerIds.has(task.consumerId)
      || (task.owner !== undefined && !text(task.owner)) || !['high', 'normal'].includes(String(task.priority))
      || !strings(task.checkIds) || !task.checkIds.every((id) => checkIds.has(id))
      || !strings(task.changeIds) || !text(task.action) || !text(task.verification)) return undefined
  }
  return value as unknown as ConsumerImpactReport
}
