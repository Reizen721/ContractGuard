import { describe, expect, it, beforeEach } from 'vitest'
import { locale, setLocale, toggleLocale, translateText, setupDomI18n } from './i18n'

describe('i18n translation system', () => {
  beforeEach(() => {
    setLocale('zh-CN')
  })

  it('defaults to zh-CN and toggles to en', () => {
    expect(locale.value).toBe('zh-CN')
    toggleLocale()
    expect(locale.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    toggleLocale()
    expect(locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('translates exact key phrases to English', () => {
    expect(translateText('新建分析')).toBe('Analysis')
    expect(translateText('自修复 Agent')).toBe('Self-Repair Agent')
    expect(translateText('运行 CEGAR 闭环')).toBe('Run CEGAR Loop')
    expect(translateText('分析引擎在线')).toBe('Engine Online')
    expect(translateText('未发现确定性破坏')).toBe('No Deterministic Breaking Changes')
  })

  it('translates pattern-based phrases with dynamic numbers', () => {
    expect(translateText('4 组')).toBe('4 presets')
    expect(translateText('2 轮精化')).toBe('2-round repair')
    expect(translateText('1 个文件')).toBe('1 file(s)')
    expect(translateText('4. 对抗见证 1/1')).toBe('4. Witnesses 1/1')
    expect(translateText('捕获 1 项反例')).toBe('1 Counterexample(s)')
    expect(translateText('原始契约门禁: BLOCKED')).toBe('Server Gate: BLOCKED')
  })

  it('translates DOM text nodes dynamically when locale is en and restores on zh-CN', async () => {
    const cleanup = setupDomI18n()
    const container = document.createElement('div')
    container.innerHTML = '<button id="btn">新建分析</button><span id="txt">4 组</span><input id="inp" placeholder="搜索变更" />'
    document.body.appendChild(container)

    try {
      setLocale('en')
      // Let DOM observer / update trigger
      await new Promise((r) => setTimeout(r, 20))
      expect(document.getElementById('btn')?.textContent).toBe('Analysis')
      expect(document.getElementById('txt')?.textContent).toBe('4 presets')
      expect(document.getElementById('inp')?.getAttribute('placeholder')).toBe('Search findings')

      setLocale('zh-CN')
      await new Promise((r) => setTimeout(r, 20))
      expect(document.getElementById('btn')?.textContent).toBe('新建分析')
      expect(document.getElementById('txt')?.textContent).toBe('4 组')
      expect(document.getElementById('inp')?.getAttribute('placeholder')).toBe('搜索变更')
    } finally {
      cleanup()
      container.remove()
    }
  })
})
