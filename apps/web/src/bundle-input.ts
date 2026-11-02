import type { ContractBundleInput } from './types'

export const MAX_CONTRACT_FILES = 50
export const MAX_CONTRACT_BYTES = 5 * 1024 * 1024

/** Reads only files the user explicitly selected; never performs network or filesystem traversal. */
export async function bundleFromFiles(selected: File[], directory: boolean): Promise<ContractBundleInput> {
  const files = selected.filter((file) => /\.(ya?ml|json)$/i.test(file.name))
  if (!files.length) throw new Error('所选内容中没有 YAML / JSON 文件。')
  if (files.length > MAX_CONTRACT_FILES) throw new Error('每份契约最多包含 50 个 YAML / JSON 文件，请仅选择契约目录。')
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_CONTRACT_BYTES) throw new Error('每份契约的文件总大小不能超过 5 MiB。')
  const roots = directory ? new Set(files.map((file) => file.webkitRelativePath.split('/')[0])) : new Set<string>()
  if (directory && (roots.size !== 1 || roots.has(''))) throw new Error('无法识别契约目录的相对路径，请重新选择单个目录。')
  const paths = new Set<string>()
  const entries = files.map((file) => {
    const path = directory ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name
    if (!path || /[\\:\u0000?#]/.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`不支持的契约文件路径：${file.name}`)
    }
    const folded = path.toLowerCase()
    if (paths.has(folded)) throw new Error(`文件路径重复或仅大小写不同：${path}。嵌套文件请使用目录导入。`)
    paths.add(folded)
    return { path, file }
  })
  const contents = await Promise.all(entries.map(async ({ path, file }) => ({ path, content: await file.text() })))
  if (contents.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0) > MAX_CONTRACT_BYTES) {
    throw new Error('每份契约的 UTF-8 文本总大小不能超过 5 MiB。')
  }
  contents.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const namedEntry = ['openapi.yaml', 'openapi.yml', 'openapi.json'].find((path) => contents.some((file) => file.path === path))
  const detected = contents.find((file) => /(?:^|\n)\s*openapi\s*:\s*['"]?3\./.test(file.content)
    || (() => { try { return typeof JSON.parse(file.content).openapi === 'string' } catch { return false } })())
  return { kind: 'bundle', entry: namedEntry ?? detected?.path ?? contents[0]!.path, files: contents }
}
