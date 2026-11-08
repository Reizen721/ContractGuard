<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { bundleFromFiles, MAX_CONTRACT_BYTES } from '../bundle-input'
import type { ContractBundleInput } from '../types'

const props = defineProps<{
  modelValue: string
  title: string
  eyebrow: string
  fileName: string
  accent: 'baseline' | 'candidate'
  bundle?: ContractBundleInput | null
  resetKey?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:fileName': [value: string]
  error: [message: string]
  'update:bundle': [value: ContractBundleInput | null]
  loading: [value: boolean]
}>()

const input = ref<HTMLInputElement | null>(null)
const directoryInput = ref<HTMLInputElement | null>(null)
const multipleInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const reading = ref(false)
const previewPath = ref('')
const isBundle = computed(() => props.bundle != null)
const preview = computed(() => props.bundle?.files.find((file) => file.path === previewPath.value)
  ?? props.bundle?.files.find((file) => file.path === props.bundle?.entry)
  ?? props.bundle?.files[0])
let dragDepth = 0
let readSequence = 0

function cancelRead(): void {
  readSequence += 1
  reading.value = false
  emit('loading', false)
}

watch(() => props.resetKey, cancelRead, { flush: 'sync' })
watch(() => props.modelValue, cancelRead, { flush: 'sync' })
onBeforeUnmount(cancelRead)

function setMode(bundleMode: boolean): void {
  if (bundleMode === isBundle.value) return
  cancelRead()
  previewPath.value = ''
  emit('update:bundle', bundleMode ? { kind: 'bundle', entry: '', files: [] } : null)
  emit('update:modelValue', '')
  emit('update:fileName', `${props.accent}.yaml`)
}

async function loadBundle(files: File[], directory: boolean): Promise<void> {
  cancelRead()
  const sequence = readSequence
  reading.value = true
  emit('loading', true)
  try {
    const bundle = await bundleFromFiles(files, directory)
    if (sequence !== readSequence) return
    reading.value = false
    emit('loading', false)
    previewPath.value = bundle.entry
    emit('update:modelValue', '')
    emit('update:fileName', bundle.entry)
    emit('update:bundle', bundle)
  } catch (error) {
    if (sequence === readSequence) emit('error', error instanceof Error ? error.message : '无法读取契约文件。')
  } finally {
    if (sequence === readSequence) {
      reading.value = false
      emit('loading', false)
    }
  }
}

async function onBundleInput(event: Event, directory: boolean): Promise<void> {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  target.value = ''
  if (files.length) await loadBundle(files, directory)
}

function selectEntry(event: Event): void {
  cancelRead()
  const entry = (event.target as HTMLSelectElement).value
  if (!props.bundle) return
  previewPath.value = entry
  emit('update:bundle', { ...props.bundle, entry })
  emit('update:fileName', entry)
}

async function loadFile(file?: File): Promise<void> {
  if (!file) return
  const allowed = /\.(ya?ml|json)$/i.test(file.name)
  if (!allowed) {
    emit('error', '请选择 .yaml、.yml 或 .json 格式的 OpenAPI 文件。')
    return
  }
  cancelRead()
  const sequence = readSequence
  reading.value = true
  emit('loading', true)
  try {
    if (file.size > MAX_CONTRACT_BYTES) throw new Error('单份规范不能超过 5 MiB。')
    const text = await file.text()
    if (sequence !== readSequence) return
    if (new TextEncoder().encode(text).byteLength > MAX_CONTRACT_BYTES) throw new Error('单份规范不能超过 5 MiB。')
    reading.value = false
    emit('loading', false)
    emit('update:bundle', null)
    emit('update:modelValue', text)
    emit('update:fileName', file.name)
  } catch (error) {
    if (sequence === readSequence) emit('error', error instanceof Error ? error.message : `无法读取文件：${file.name}`)
  } finally {
    if (sequence === readSequence) {
      reading.value = false
      emit('loading', false)
    }
  }
}

async function onInput(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  await loadFile(target.files?.[0])
  target.value = ''
}

function onDrop(event: DragEvent): void {
  dragDepth = 0
  isDragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (isBundle.value || files.length > 1) void loadBundle(files, false)
  else void loadFile(files[0])
}

function onDragEnter(): void {
  dragDepth += 1
  isDragging.value = true
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) isDragging.value = false
}
</script>

<template>
  <section
    class="spec-panel"
    :class="[`spec-panel--${accent}`, { 'is-dragging': isDragging }]"
    :aria-labelledby="`spec-${accent}-title`"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="spec-panel__header">
      <div>
        <h3 :id="`spec-${accent}-title`">{{ title }}</h3>
        <span class="spec-version-label">{{ eyebrow }}</span>
      </div>
    </header>

    <div class="contract-mode" role="group" :aria-label="`${title}输入模式`">
      <button type="button" :aria-pressed="!isBundle" @click="setMode(false)">单文件文本</button>
      <button type="button" :aria-pressed="isBundle" @click="setMode(true)">多文件契约</button>
    </div>

    <div v-if="isBundle" class="bundle-panel">
      <div class="bundle-actions">
        <button class="button button--quiet button--small" type="button" @click="directoryInput?.click()">导入目录</button>
        <button class="button button--quiet button--small" type="button" @click="multipleInput?.click()">选择同目录文件</button>
        <input ref="directoryInput" class="sr-only" type="file" multiple webkitdirectory :aria-label="`导入${title}契约目录`" @change="onBundleInput($event, true)" />
        <input ref="multipleInput" class="sr-only" type="file" multiple accept=".yaml,.yml,.json" :aria-label="`导入${title}多个文件`" @change="onBundleInput($event, false)" />
      </div>
      <label class="bundle-entry">
        <span>入口文件</span>
        <select :aria-label="`${title}入口文件`" :value="bundle?.entry ?? ''" :disabled="reading || !bundle?.files.length" @change="selectEntry">
          <option v-if="!bundle?.files.length" value="">先选择契约文件</option>
          <option v-for="file in bundle?.files" :key="file.path" :value="file.path">{{ file.path }}</option>
        </select>
      </label>
      <details v-if="bundle?.files.length" class="bundle-file-list">
        <summary>已选择 {{ bundle.files.length }} 个文件（查看清单与预览）</summary>
        <ul><li v-for="file in bundle.files" :key="file.path"><button type="button" @click="previewPath = file.path">{{ file.path }}</button></li></ul>
      </details>
      <p v-if="preview" class="bundle-preview-label">只读预览：{{ preview.path }}</p>
      <pre v-if="preview" class="bundle-preview">{{ preview.content }}</pre>
      <p v-else class="bundle-empty">选择包含入口规范及其相对引用文件的目录。</p>
    </div>

    <div v-else class="file-row">
      <div class="file-name" :title="fileName">
        <span class="file-icon" aria-hidden="true">⌁</span>
        <span>{{ fileName || '尚未选择文件' }}</span>
      </div>
      <button class="button button--quiet button--small" type="button" @click="input?.click()">
        导入文件
      </button>
      <input
        ref="input"
        class="sr-only"
        type="file"
        accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
        :aria-label="`导入${title}`"
        @change="onInput"
      />
    </div>

    <label v-if="!isBundle" class="editor-wrap">
      <span class="sr-only">{{ title }}内容</span>
      <textarea
        class="spec-editor"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        :aria-describedby="`spec-${accent}-count`"
        :value="props.modelValue"
        :placeholder="`在此粘贴${title}，或拖拽文件到面板`"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <footer class="spec-panel__footer">
      <span>{{ reading ? '正在读取选择的文件…' : '' }}</span>
      <span :id="`spec-${accent}-count`">{{ isBundle ? `${bundle?.files.length ?? 0} 个文件` : `${modelValue.length.toLocaleString()} 字符` }}</span>
    </footer>
  </section>
</template>
