<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { CONSUMER_EVIDENCE_MAX_BYTES, parseConsumerEvidence } from '../consumer-evidence'

const props = defineProps<{ modelValue: string; error?: string; resetKey: number }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; loading: [value: boolean]; demo: [] }>()
const fileInput = ref<HTMLInputElement | null>(null)
const fileError = ref('')
const reading = ref(false)
const expanded = ref(false)
let sequence = 0

function cancelRead(): void {
  sequence += 1
  reading.value = false
  emit('loading', false)
}
watch(() => props.resetKey, () => { cancelRead(); fileError.value = '' })
watch(() => props.modelValue, () => { cancelRead(); fileError.value = ''; if (props.modelValue) expanded.value = true }, { flush: 'sync' })
onBeforeUnmount(cancelRead)

function edit(event: Event): void {
  cancelRead()
  fileError.value = ''
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
function clear(): void { cancelRead(); fileError.value = ''; emit('update:modelValue', '') }

async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  cancelRead()
  const current = sequence
  fileError.value = ''
  reading.value = true
  expanded.value = true
  emit('loading', true)
  try {
    if (file.size > CONSUMER_EVIDENCE_MAX_BYTES) throw new Error('调用方样例超过 1 MiB，请拆分后重新导入。')
    const text = await file.text()
    if (current !== sequence) return
    if (!parseConsumerEvidence(text)) throw new Error('文件为空，请选择包含调用方样例的 JSON 文件。')
    reading.value = false
    emit('loading', false)
    emit('update:modelValue', text)
  } catch (error) {
    if (current !== sequence) return
    fileError.value = `${error instanceof Error ? error.message : '文件读取失败，请重新选择。'} 现有输入未被替换。`
  } finally {
    if (current === sequence) { reading.value = false; emit('loading', false) }
  }
}
</script>

<template>
  <section class="consumer-input" aria-labelledby="consumer-input-title" :aria-busy="reading">
    <div class="consumer-input__heading">
      <div>
        <h3 id="consumer-input-title">调用方样例 <span>可选</span></h3>
        <p id="consumer-input-help">加入调用方的请求样例、升级前后响应和读取约束，验证具体交互是否出现回归。仅检查提交的样例，不请求实际接口。</p>
      </div>
      <button class="text-button" type="button" @click="emit('demo')">载入调用方示例</button>
    </div>
    <div class="consumer-input__actions">
      <button class="button button--quiet" type="button" @click="fileInput?.click()">{{ reading ? '重新选择文件' : '导入样例 JSON' }}</button>
      <button class="text-button" type="button" :aria-expanded="expanded" aria-controls="consumer-evidence-editor" @click="expanded = !expanded">{{ expanded ? '收起输入' : '粘贴或编辑 JSON' }}</button>
      <button v-if="modelValue || reading || fileError" class="text-button" type="button" @click="clear">清空调用方样例</button>
      <span v-if="reading" role="status">正在读取样例…</span>
      <span v-else-if="modelValue && !error">已附加样例；运行分析时检查内容</span>
      <input ref="fileInput" class="sr-only" type="file" accept=".json,application/json" aria-label="导入调用方样例 JSON" @change="importFile" />
    </div>
    <div v-show="expanded" id="consumer-evidence-editor">
      <label class="sr-only" for="consumer-evidence-json">调用方样例 JSON</label>
      <textarea id="consumer-evidence-json" :value="modelValue" :aria-invalid="Boolean(error)" aria-describedby="consumer-input-help consumer-input-note consumer-input-error" spellcheck="false" placeholder="粘贴 schemaVersion 为 1 的调用方样例 JSON，或载入完整示例。" @input="edit" />
      <p id="consumer-input-note">最多 1 MiB。请先脱敏。样例内容只用于本次本地验证；保存的报告包含结果和指纹。</p>
    </div>
    <p v-if="error || fileError" id="consumer-input-error" class="consumer-input__error" role="alert">{{ error || fileError }}</p>
  </section>
</template>
