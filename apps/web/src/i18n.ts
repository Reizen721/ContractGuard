import { nextTick, ref, watch } from 'vue'

export type Locale = 'zh-CN' | 'en'

function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN'
  try {
    const urlLang = new URLSearchParams(window.location.search).get('lang')?.toLowerCase()
    if (urlLang === 'en' || urlLang === 'en-us') return 'en'
    if (urlLang === 'zh' || urlLang === 'zh-cn') return 'zh-CN'
    const stored = window.localStorage.getItem('contractguard.locale')
    if (stored === 'en' || stored === 'zh-CN') return stored
  } catch {
    // Storage may be unavailable in test environments
  }
  return 'zh-CN'
}

export const locale = ref<Locale>(readInitialLocale())

export function setLocale(next: Locale): void {
  locale.value = next
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next
  }
  try {
    window.localStorage.setItem('contractguard.locale', next)
  } catch {
    // Ignore storage write errors
  }
}

export function toggleLocale(): void {
  setLocale(locale.value === 'zh-CN' ? 'en' : 'zh-CN')
}

export function t(zh: string, en: string): string {
  return locale.value === 'en' ? en : zh
}

const EXACT_DICT: Record<string, string> = {
  // Navigation & Topbar
  '新建分析': 'Analysis',
  '自修复 Agent': 'Self-Repair Agent',
  'Agent 审查': 'Agent Review',
  '分析历史': 'History',
  '规则目录': 'Rules',
  '分析': 'Analyze',
  '自修复': 'Repair',
  '历史': 'History',
  '规则': 'Rules',
  '正在检测服务': 'Checking Service…',
  '分析引擎在线': 'Engine Online',
  '分析引擎离线': 'Engine Offline',
  '主导航': 'Main navigation',
  '移动端主导航': 'Mobile navigation',
  'ContractGuard 首页': 'ContractGuard Home',
  '返回新建分析': 'Back to Analysis',
  '切换语言': 'Switch language',
  '关闭通知': 'Dismiss notification',

  // Analyze View & SpecPanel
  '历史分析报告': 'Saved Analysis Report',
  'OpenAPI 兼容性分析': 'OpenAPI Compatibility Analysis',
  '返回编辑区': 'Back to Editor',
  '载入演示规范': 'Load Demo Spec',
  '载入多文件示例': 'Load Multi-File Bundle',
  '清空': 'Clear',
  '输入规范': 'Input Specifications',
  '基线规范': 'Baseline Spec',
  '当前版本': 'Current Release',
  '候选规范': 'Candidate Spec',
  '待发布版本': 'Proposed Release',
  '单文件文本': 'Single File',
  '多文件契约': 'Multi-File Bundle',
  '导入目录': 'Import Folder',
  '选择同目录文件': 'Select Files',
  '入口文件': 'Entry File',
  '先选择契约文件': 'Select contract files first',
  '选择包含入口规范及其相对引用文件的目录。': 'Select a folder containing the entry spec and its relative $ref files.',
  '尚未选择文件': 'No file selected',
  '导入文件': 'Import File',
  '拖拽 .yaml / .json 到此处，或直接在下方粘贴 OpenAPI 3.0 / 3.1 规范': 'Drop a .yaml / .json file here, or paste an OpenAPI 3.0 / 3.1 specification below',
  '交给 Agent 审查': 'Send to Agent Review',
  '正在分析…': 'Analyzing…',
  '正在读取文件…': 'Reading files…',
  '运行兼容性分析': 'Run Compatibility Analysis',
  '输入已变更：下方报告对应上一次提交的规范，请重新运行分析。': 'Inputs changed: the report below reflects the previous submission. Run analysis again.',
  '导出报告': 'Export Report',
  '选择报告格式': 'Select report format',
  '报告来源与策略': 'Report Provenance & Policy',
  '引擎版本': 'Engine Version',
  '规则策略': 'Rule Policy',
  '基线方言': 'Baseline Dialect',
  '候选方言': 'Candidate Dialect',
  '基线 SHA-256': 'Baseline SHA-256',
  '候选 SHA-256': 'Candidate SHA-256',
  '策略 SHA-256': 'Policy SHA-256',
  '旧版记录未保存': 'Not recorded in legacy entry',

  // Consumer Evidence Input & Impact
  '调用方样例': 'Consumer Samples',
  '可选': 'Optional',
  '重新选择文件': 'Reselect File',
  '导入样例 JSON': 'Import Sample JSON',
  '收起输入': 'Collapse Input',
  '粘贴或编辑 JSON': 'Paste or Edit JSON',
  '载入调用方示例': 'Load Consumer Demo',
  '清空调用方样例': 'Clear Samples',
  '正在读取样例…': 'Reading samples…',
  '已附加样例': 'Samples Attached',
  '调用方样例 JSON': 'Consumer Sample JSON',
  '粘贴 schemaVersion 为 1 的调用方样例 JSON，或点击上方载入调用方示例。': 'Paste a schemaVersion 1 consumer evidence JSON, or click Load Consumer Demo above.',
  '调用方影响验证': 'Consumer Impact Verification',
  '发现样例回归': 'Sample Regression Detected',
  '需要复核': 'Needs Review',
  '样例范围内通过': 'Passed Within Samples',
  '回归': 'Regression',
  '基线样例无效': 'Invalid Baseline',
  '基线无效': 'Invalid Baseline',
  '证据不足': 'Inconclusive',
  '样例通过': 'Passed',
  '符合已验证约束': 'Valid against constraints',
  '不符合约束': 'Violates constraints',
  '未能完整验证': 'Partially verified',
  '关键调用方': 'Critical Consumer',
  '常规调用方': 'Standard Consumer',
  '未指定负责人': 'Unassigned owner',
  '请求样例': 'Request Sample',
  '响应与调用方约束': 'Response & Consumer Expectations',
  '问题列表已截断，仍需复核未展示的内容。': 'Issue list truncated; review omitted entries.',
  '优先处理': 'High Priority',
  '安排处理': 'Scheduled',
  '待分配负责人': 'Owner TBD',
  '验证范围与样例指纹': 'Verification Scope & Sample Fingerprint',

  // SummaryCards, Coverage, ChangeList
  '分析摘要': 'Analysis Summary',
  '未发现确定性破坏': 'No Deterministic Breaking Changes',
  '发现阻断性变更': 'Breaking Changes Detected',
  '破坏性变更': 'Breaking',
  '潜在风险': 'Potential Risk',
  '兼容变更': 'Compatible',
  '信息提示': 'Info',
  '分析覆盖范围': 'Analysis Coverage',
  '覆盖信息不完整，请使用对应版本重新分析。': 'Coverage data incomplete; re-run analysis with the current engine.',
  '提示数量已达到展示上限，请缩小契约范围后复核。': 'Coverage warnings truncated; narrow contract scope for full review.',
  '变更明细': 'Change Findings',
  '搜索变更': 'Search findings',
  '搜索路径、文件、规则或描述': 'Search paths, files, rules, or messages',
  '按严重度筛选': 'Filter by severity',
  '全部': 'All',
  '破坏性': 'Breaking',
  '兼容': 'Compatible',
  '信息': 'Info',
  '基线原文件': 'Baseline Source',
  '候选原文件': 'Candidate Source',
  '变更前': 'Before',
  '变更后': 'After',
  '迁移建议': 'Migration Advice',
  '没有匹配的变更': 'No Matching Changes',
  '未检测到契约变更': 'No Contract Changes Detected',
  '调整搜索词或严重度筛选条件。': 'Adjust your search query or severity filter.',
  '两份规范在当前规则集下没有产生差异。': 'Both specifications are equivalent under the active rule set.',
  '清除筛选': 'Reset Filters',

  // CEGAR Self-Repair Workspace
  '神经符号自修复 Agent 工作台': 'Neuro-Symbolic CEGAR Self-Repair Workbench',
  '正在验证精化…': 'Verifying & Refining…',
  '运行 CEGAR 闭环': 'Run CEGAR Loop',
  '基准场景': 'Benchmark Scenarios',
  '选择 CEGAR 演示场景': 'Select CEGAR scenario',
  '零补丁剪枝': '0-Patch Pruned',
  '验证器配置': 'Verifier Settings',
  '合成策略': 'Synthesis Mode',
  '符号 AST + TypeChecker': 'Symbolic AST + TypeChecker',
  '混合模式 (AST + LLM)': 'Hybrid (AST + LLM)',
  'LLM 闭环': 'LLM Closed-Loop',
  'LLM 闭环 (未配置)': 'LLM Closed-Loop (Unconfigured)',
  '轮数上限': 'Max Rounds',
  '1 轮 (单轮对照)': '1 Round (Single-Step Baseline)',
  '2 轮': '2 Rounds',
  '4 轮 (标准)': '4 Rounds (Default)',
  '启用对抗见证 Fuzzing': 'Enable Adversarial Witness Fuzzing',
  '编辑调用方 TypeScript 源码': 'Edit caller TypeScript source',
  '最近记录': 'Recent Runs',
  '正在连接自修复引擎…': 'Connecting to CEGAR Engine…',
  '四门确定性沙箱驱动的多轮自修复': 'Multi-Round Self-Repair Driven by a 4-Gate Sandbox',
  '选择左侧场景并点击「运行 CEGAR 闭环」，查看契约对齐、程序切片与反例收敛过程。': 'Select a scenario on the left and click "Run CEGAR Loop" to inspect schema alignment, program slicing, and counterexample refinement.',
  '已验证修复': 'Verified Repair',
  '不可达免改': 'Unreachable Safe',
  '兼容通过': 'Compatible',
  '未收敛阻断': 'Unresolved Blocked',
  '导出 MD': 'Export MD',
  '精化收敛轮数': 'Refinement Rounds',
  '程序切片降噪': 'Slice Reduction',
  '差分对抗见证': 'Adversarial Witnesses',
  '已验证补丁文件': 'Verified Patches',
  '自动契约对齐假设': 'Schema Alignment Hypotheses',
  '无结构重命名或类型漂移假设（纯删除或向后兼容变更）。': 'No structural or type-shift hypotheses (pure removal or backward-compatible change).',
  '差分边界见证集': 'Differential Adversarial Witnesses',
  '候选契约未引入新的可空、可选或扩展枚举边界。': 'Candidate contract introduces no new nullable, optional, or enum boundary variants.',
  'CEGAR 反例精化轨迹': 'CEGAR Refinement Trajectory',
  '全部验证门通过': 'All 4 Gates Passed',
  '2. 常规单测 ✓': '2. Nominal Tests ✓',
  '2. 常规单测 ✗': '2. Nominal Tests ✗',
  '3. 请求契约 ✓': '3. Request Contract ✓',
  '3. 请求契约 ✗': '3. Request Contract ✗',
  '已验证源码补丁 (Unified Diff)': 'Verified Source Patches (Unified Diff)',

  // CEGAR Built-in Presets (Titles & Descriptions)
  '订单结构嵌套 + 可空反例精化': 'Nested Order Object + Nullable Witness Refinement',
  '自动推导结构嵌套与分转元，捕获 reviewer: null 空指针并在第 2 轮补齐空值保护。': 'Infers nested path & cents-to-decimal conversion, catches reviewer: null TypeError, and adds null-safe coalescing in Round 2.',
  '订单徽章：结构嵌套 + 分转元 + WIT-NULL 反例精化': 'Order Badge: Structural Nesting + Cents-to-Decimal + WIT-NULL Refinement',
  '枚举映射 + 新增分支穷尽修复': 'Enum Remapping + Exhaustive Variant Repair',
  '迁移状态重命名并通过 WIT-ENUM 见证捕获 switch 新增分支异常，自动补齐安全兜底。': 'Remaps renamed enum values, catches unhandled switch variant via WIT-ENUM witness, and synthesizes a safe fallback branch.',
  '物流状态：枚举重命名 + 新增 ON_HOLD 分支反例精化': 'Shipment Status: Enum Remapping + New ON_HOLD Variant Refinement',
  '跨模块切片 + 必填请求参数迁移': 'Cross-Module Slicing + Required Query Param Migration',
  '跨 3 个模块追踪 HTTP 响应数据流，同步修复新增必填查询参数与嵌套属性。': 'Traces HTTP response dataflow across 3 modules, repairing both a newly required query parameter and nested response fields.',
  '跨模块发票：3 文件切片 + 新增必填查询参数与嵌套字段修复': 'Cross-Module Invoices: 3-File Slice + Required Query & Nested Field Repair',
  '不可达破坏性变更自动剪枝': 'Unreachable Breaking Change Pruning',
  '证明被删字段在当前调用链不可达，零补丁通过全部四道验证门，消除误报。': 'Proves removed fields are unreachable in the active call graph, passing all 4 gates with 0 patches while retaining server gate audit.',
  '不可达对照：静态破坏性变更在当前调用链零可达（免改证明）': 'Unreachable Control: Static Breaking Changes Uncalled by Client (0-Patch Proof)',

  // Agent Review Workspace
  '发布审查任务': 'Release Review Workspace',
  '编辑契约与调用方样例': 'Edit Contracts & Samples',
  '正在检测检查引擎…': 'Checking engine…',
  '本地检查引擎就绪': 'Local Engine Ready',
  '本地检查引擎未就绪': 'Local Engine Unavailable',
  '重新检测': 'Recheck',
  '任务提交与历史': 'Task submission and history',
  '新任务': 'New Review',
  '材料来源': 'Input Source',
  '当前契约编辑区': 'Current Spec Editor',
  '已登记项目与测试': 'Registered Project & Tests',
  '调用方迁移输入包': 'Caller Migration Bundle',
  '选择项目': 'Select Project',
  '正在读取…': 'Loading…',
  '请选择已登记项目': 'Select a registered project',
  '尚未登记项目。': 'No projects registered.',
  '刷新项目': 'Refresh Projects',
  '导入迁移输入包': 'Import Migration JSON',
  '使用调用方迁移示例': 'Load Caller Migration Demo',
  '正在读取材料…': 'Reading input…',
  '输入来自契约编辑区': 'Source: Spec Editor',
  '输入来自迁移材料': 'Source: Migration Bundle',
  '尚未选择基线': 'No baseline selected',
  '尚未选择候选': 'No candidate selected',
  '附带调用方样例': 'Includes consumer samples',
  '未附带调用方样例': 'No consumer samples attached',
  '前往输入': 'Go to Editor',
  '执行方式': 'Execution Mode',
  '固定检查流程': 'Deterministic Workflow',
  'LLM 自主编排': 'LLM Autonomous Planner',
  '规划模型': 'Planner Model',
  '审查目标': 'Review Goal',
  '正在提交…': 'Submitting…',
  '开始审查': 'Start Review',
  '最近任务': 'Recent Tasks',
  '刷新': 'Refresh',
  '暂无保存的任务。': 'No saved tasks yet.',
  '排队中': 'Queued',
  '检查中': 'Running',
  '已完成': 'Completed',
  '执行失败': 'Failed',
  '已取消': 'Cancelled',
  '已中断': 'Interrupted',
  '固定流程': 'Workflow',
  '正在载入任务…': 'Loading task…',
  '审查结果': 'Review Report',
  '基线': 'Baseline',
  '候选': 'Candidate',
  '正在取消…': 'Cancelling…',
  '取消任务': 'Cancel Task',
  '固定检查流程 · 无大模型': 'Deterministic Workflow · Model-Free',
  '审查报告目录': 'Review report sections',
  '结论': 'Verdict',
  '检查过程': 'Trace',
  '契约证据': 'Contract Findings',
  '调用方证据': 'Caller Evidence',
  '项目测试': 'Project Tests',
  '迁移事项': 'Migration Tasks',
  '重新获取状态': 'Resume Polling',
  '发现阻断项': 'Blocking Issues Detected',
  '需要人工复核': 'Manual Review Required',
  '已执行检查未发现阻断项': 'No Blocking Issues Found',
  '尚无完整判定': 'Verdict Pending',
  '规则判定': 'Deterministic Gate',
  '等待检查结果。': 'Waiting for check results.',
  '执行中，自动更新': 'Running · Live updating',
  '已保存的执行记录': 'Saved execution trace',
  '任务已提交，等待执行第一步。': 'Task queued, waiting for first step.',
  '校验基线规范': 'Validate Baseline Spec',
  '校验候选规范': 'Validate Candidate Spec',
  '检查破坏性变更': 'Check Breaking Changes',
  '生成变更清单': 'Generate Changelog',
  '检查契约与调用方证据': 'Analyze Contract & Consumer Evidence',
  '检查变更统计': 'Summarize Change Counts',
  '读取结构差异': 'Inspect Structural Diff',
  '定位调用方并验证候选补丁': 'Locate Callers & Verify Candidate Patches',
  '运行项目已有测试': 'Run Registered Project Tests',
  '失败': 'Failed',
  '执行中': 'Running',
  '上游检查证据': 'Upstream oasdiff Findings',
  '等待检查输出。': 'Waiting for check output.',
  '本次没有可列出的上游发现。': 'No upstream findings reported.',
  '发现列表已截断。': 'Findings list truncated.',
  '调用方迁移证据': 'Caller Migration Evidence',
  '查看源码位置与补丁': 'Inspect Callsites & Patches',
  '模型建议 · 需人工确认': 'LLM Advice · Verify Manually',
  '基于检查结果的建议': 'Evidence-Based Recommendations',
  '输入快照与运行版本': 'Input Fingerprints & Engine Versions',
  '尚未执行': 'Not executed',
  '基线摘要': 'Baseline SHA-256',
  '候选摘要': 'Candidate SHA-256',
  '未记录': 'Not recorded',
  '模型配置': 'Model Profile',
  '服务默认配置': 'Server default profile',
  '未使用大模型': 'Model-free',
  '导出 Markdown': 'Export Markdown',
  '导出 JSON': 'Export JSON',
  '把变更交给检查流程。': 'Run a Full Release Review',
  '选择已登记项目、导入调用方迁移包，或使用编辑区的契约，再提交审查。这里会逐步展示检查动作、规则证据和迁移事项。': 'Select a registered project, import a caller migration bundle, or use the specs from the editor to run a multi-step release review.',
  '校验输入': 'Validate Inputs',
  '确认两侧契约可被检查引擎解析。': 'Verify both specifications parse cleanly.',
  '执行检查': 'Run Checks',
  '检查契约与调用方，并运行已登记的项目测试。': 'Run contract rules, caller analysis, and project test suites.',
  '复核迁移': 'Review Migration',
  '沿证据定位风险，保留未覆盖范围。': 'Trace breaking risks to exact evidence IDs.',

  // ProjectTestEvidence & CallerWorkspace
  '项目已有测试': 'Registered Project Tests',
  '已执行测试通过': 'Executed Tests Passed',
  '候选引入测试回归': 'Candidate Introduced Test Regression',
  '基线测试未通过': 'Baseline Tests Failed',
  '测试证据不足': 'Test Evidence Inconclusive',
  '通过': 'Passed',
  '已通过项目测试': 'Verified by Project Tests',
  '尚未验证': 'Unverified',
  '未生成候选补丁': 'No Patch Proposed',
  '补丁副本': 'Patched Copy',
  '阶段': 'Phase',
  '结果': 'Status',
  '通过 / 失败 / 跳过': 'Pass / Fail / Skip',
  '退出码': 'Exit Code',
  '没有保存原始测试输出。': 'No raw test output recorded.',
  '输出已截断。': 'Output truncated.',
  '测试文件与项目快照': 'Test Files & Project Snapshot',
  '调用方迁移验证': 'Caller AST Replay & Migration',
  '载入迁移示例': 'Load Migration Demo',
  '新建审查': 'New Caller Review',
  '提交契约、源码与测试样例': 'Submit Contracts, Caller Source & Fixtures',
  '导入 JSON 文件': 'Import JSON File',
  '审查输入 JSON': 'Caller Review Input JSON',
  '正在定位与重放…': 'Locating callsites & replaying…',
  '运行调用方审查': 'Run Caller Review',
  '审查历史': 'Caller Review History',
  '正在读取历史…': 'Loading history…',
  '暂无审查记录。': 'No caller reviews saved.',
  '本次证据通过': 'Passed on Supplied Evidence',
  '存在阻断风险': 'Blocking Regression Found',
  '候选版本回归': 'Candidate Regression',
  '基线不满足预期': 'Invalid Baseline',
  '无法确定': 'Inconclusive',
  '已定位': 'Resolved',
  '未解析': 'Unresolved',
  '已在副本验证': 'Verified on Copy',
  '验证失败': 'Verification Failed',
  '未完成验证': 'Unverified',
  '符合预期': 'Passed',
  '超出支持范围': 'Unsupported Syntax',
  '代码位置与关联证据': 'Callsite Locations & Linked Evidence',
  '没有定位到受支持的调用点。': 'No supported callsites detected.',
  '查看关联契约规则结果': 'View Linked Contract Rule Findings',
  '基线与候选重放': 'Baseline vs. Candidate Fixture Replay',
  '没有提交可重放的场景。': 'No replay scenarios supplied.',
  '候选补丁': 'Proposed Patches',
  '没有生成补丁。': 'No patches generated.',
  '查看补丁与验证结果': 'View Unified Diff & Replay Outcomes',
  '正在读取与检查证据…': 'Analyzing caller source and replaying fixtures…',
  '从具体调用方判断迁移影响': 'Evaluate Caller Impact from Source & Fixtures',
  '点击右上角载入迁移示例开始，或从左侧打开已保存的审查记录。': 'Click Load Migration Demo above, or select a saved review on the left.',

  // HistoryPanel & RuleDrawer & AI Interpreter
  '刷新中…': 'Refreshing…',
  '刷新记录': 'Refresh History',
  '无法读取分析历史': 'Failed to Load Analysis History',
  '重试': 'Retry',
  '正在载入分析记录…': 'Loading saved analyses…',
  '规范对比': 'Contract Pair',
  '时间': 'Timestamp',
  '静态评分': 'Score',
  '变更概览': 'Changes',
  '操作': 'Actions',
  '结果待复核': 'Needs Review',
  '未记录验证': 'Not Evaluated',
  '请打开报告查看范围': 'Open report for details',
  '查看报告': 'Open report',
  '删除记录': 'Delete record',
  '还没有分析记录': 'No Saved Analyses Yet',
  '完成第一次 OpenAPI 对比后，结果会出现在这里。': 'Run your first OpenAPI comparison to see saved reports here.',
  '每个结论均可追溯到确定性的兼容性规则。': 'Every compatibility finding traces back to a deterministic rule.',
  '关闭规则目录': 'Close rule catalog',
  '正在加载规则…': 'Loading rules…',
  '规则目录加载失败': 'Failed to Load Rule Catalog',
  '暂无规则信息': 'No Rules Loaded',
  '后端恢复连接后可重新打开查看。': 'Reconnect the local backend service and try again.',
  'AI 风险解读与迁移计划': 'AI Risk Interpretation & Migration Plan',
  '正在检测 AI 服务': 'Checking AI Service…',
  '状态检测失败': 'Status Check Failed',
  '功能未启用': 'Disabled',
  '等待 API 配置': 'Awaiting API Key',
  '服务暂不可用': 'Service Unavailable',
  'AI 配置就绪': 'AI Ready',
  '生成 AI 解读': 'Generate AI Explanation',
  '正在生成解读…': 'Generating explanation…',
  '导出 AI 解读 Markdown': 'Export AI Markdown',
  '导出 AI 解读 JSON': 'Export AI JSON',
  '严重风险': 'Critical Risk',
  '高风险': 'High Risk',
  '中等风险': 'Medium Risk',
  '低风险': 'Low Risk',
}

const PATTERN_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [/^(\d+)\s*组$/, (_, n) => `${n} presets`],
  [/^(\d+)\s*轮精化$/, (_, n) => `${n}-round repair`],
  [/^(\d+)\s*轮闭环$/, (_, n) => `${n}-round loop`],
  [/^(\d+)\s*轮$/, (_, n) => `${n} round(s)`],
  [/^(\d+)\s*项$/, (_, n) => `${n} items`],
  [/^(\d+)\s*个$/, (_, n) => `${n}`],
  [/^(\d+)\s*个文件$/, (_, n) => `${n} file(s)`],
  [/^(\d+)\s*组载荷$/, (_, n) => `${n} payload(s)`],
  [/^查看 \/ 编辑调用方源码 \((\d+)\s*个文件\)$/, (_, n) => `View / Edit Caller Source (${n} file${n === '1' ? '' : 's'})`],
  [/^原始契约门禁:\s*(.+)$/, (_, g) => `Server Gate: ${g}`],
  [/^捕获\s*(\d+)\s*项反例$/, (_, n) => `${n} Counterexample(s)`],
  [/^4\.\s*对抗见证\s*(\d+)\/(\d+)$/, (_, a, b) => `4. Witnesses ${a}/${b}`],
  [/^经\s*(\d+)\s*轮反例精化生成\s*(\d+)\s*个补丁，全部通过 TypeChecker、常规单测、出站契约及\s*(\d+)\/(\d+)\s*项对抗见证验证。$/, (_, r, p, a, b) => `Verified ${p} patch(es) in ${r} round(s) across TypeChecker, unit tests, outbound request contracts, and ${a}/${b} adversarial witnesses.`],
  [/^静态发现\s*(\d+)\s*处破坏性变更，但跨模块切片证明当前调用链均不可达；零补丁通过全部四道验证门（原始契约门禁仍为\s*(\w+)\s*）。$/, (_, c, g) => `${c} static breaking change(s) proven unreachable by cross-module slicing; passed all 4 gates with 0 patches (server gate remains ${g}).`],
  [/^候选契约未触发调用方回归，无需生成源码补丁。$/, () => 'Candidate contract caused no caller regression; 0 patches needed.'],
  [/^经\s*(\d+)\s*轮尝试仍余\s*(\d+)\s*项反例未消除，按安全策略不输出未验证补丁。$/, (_, r, c) => `${c} counterexample(s) remained after ${r} round(s); unverified patches withheld by safety policy.`],
  [/^兼容参考分\s*(\d+)\s*\/\s*100$/, (_, s) => `Compatibility Score ${s} / 100`],
  [/^(\d+)\s*破坏$/, (_, n) => `${n} breaking`],
  [/^(\d+)\s*风险$/, (_, n) => `${n} risk`],
  [/^(\d+)\s*总计$/, (_, n) => `${n} total`],
  [/^(\d+)\s*回归\s*·\s*(\d+)\s*待确认\s*·\s*(\d+)\s*检查$/, (_, r, u, c) => `${r} regressions · ${u} review · ${c} checks`],
  [/^(\d+)\s*个调用方\s*·\s*(\d+)\s*个交互\s*·\s*(\d+)\s*项检查$/, (_, a, b, c) => `${a} consumers · ${b} interactions · ${c} checks`],
  [/^已选择\s*(\d+)\s*个文件（查看清单与预览）$/, (_, n) => `${n} files selected (view list & preview)`],
  [/^只读预览：(.+)$/, (_, p) => `Read-only preview: ${p}`],
  [/^(\d+)\s*步检查\s*·\s*(\d+)\s*次模型调用$/, (_, s, m) => `${s} check steps · ${m} model calls`],
  [/^阻断\s*(\d+)\s*·\s*警告\s*(\d+)$/, (_, b, w) => `${b} breaking · ${w} warnings`],
  [/^ContractGuard 规则证据（(\d+)\s*条）$/, (_, n) => `ContractGuard Native Findings (${n})`],
  [/^(\d+)\s*条证据索引$/, (_, n) => `${n} evidence ID(s)`],
  [/^附带\s*(\d+)\s*个调用方文件$/, (_, n) => `Includes ${n} caller file(s)`],
  [/^(\d+)\s*个文件\s*·\s*(\d+)\s*项样例回归\s*·\s*(\d+)\s*项无法确定\s*·\s*(\d+)\s*份补丁通过重放$/, (_, f, r, i, p) => `${f} files · ${r} regressions · ${i} inconclusive · ${p} verified patches`],
  [/^(\d+)\s*个文件\s*·\s*(\d+)\s*项回归$/, (_, f, r) => `${f} files · ${r} regressions`],
  [/^(\d+)\s*个调用点\s*·\s*(\d+)\s*项回归\s*·\s*(\d+)\s*项无法确定\s*·\s*(\d+)\s*份补丁已在副本验证$/, (_, c, r, i, p) => `${c} callsites · ${r} regressions · ${i} inconclusive · ${p} verified patches`],
  [/^补丁：(.+)$/, (_, s) => `Patch: ${translateText(s)}`],
  [/^运行器：(.+)$/, (_, r) => `Runner: ${r}`],
  [/^(.+)配置就绪$/, (_, p) => `${p.trim()} Ready`],
  [/^(\d+)\s*条未发送给模型$/, (_, n) => `${n} omitted from prompt`],
]

export function translateText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return raw
  const exact = EXACT_DICT[trimmed]
  if (exact !== undefined) {
    return raw.replace(trimmed, exact)
  }
  for (const [regex, replacer] of PATTERN_RULES) {
    const match = trimmed.match(regex)
    if (match) {
      return raw.replace(trimmed, replacer(...match))
    }
  }
  return raw
}

export function tr(raw: string): string {
  return locale.value === 'en' ? translateText(raw) : raw
}

const CJK_RE = /[\u4e00-\u9fff]/
const originalNodeText = new WeakMap<Text, string>()
const trackedTextNodes = new Set<Text>()
const originalElementAttrs = new WeakMap<Element, Map<string, string>>()
const trackedElements = new Set<Element>()
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'] as const

function processRootDom(root: ParentNode, currentLocale: Locale): void {
  if (currentLocale === 'zh-CN') {
    for (const node of trackedTextNodes) {
      const orig = originalNodeText.get(node)
      if (orig !== undefined && node.nodeValue !== orig) {
        node.nodeValue = orig
      }
    }
    for (const el of trackedElements) {
      const map = originalElementAttrs.get(el)
      if (!map) continue
      for (const [attr, orig] of map.entries()) {
        if (el.getAttribute(attr) !== orig) el.setAttribute(attr, orig)
      }
    }
    return
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current: Node | null = walker.nextNode()
  while (current) {
    const textNode = current as Text
    const parentTag = textNode.parentElement?.tagName
    if (parentTag !== 'SCRIPT' && parentTag !== 'STYLE' && parentTag !== 'CODE' && parentTag !== 'PRE' && parentTag !== 'TEXTAREA') {
      const val = textNode.nodeValue ?? ''
      if (CJK_RE.test(val)) {
        originalNodeText.set(textNode, val)
        trackedTextNodes.add(textNode)
      }
      const orig = originalNodeText.get(textNode)
      if (orig !== undefined) {
        const nextVal = translateText(orig)
        if (textNode.nodeValue !== nextVal) {
          textNode.nodeValue = nextVal
        }
      }
    }
    current = walker.nextNode()
  }

  const elements = root.querySelectorAll ? root.querySelectorAll('*') : []
  for (const el of elements) {
    for (const attr of TRANSLATABLE_ATTRS) {
      const val = el.getAttribute(attr)
      if (!val) continue
      if (CJK_RE.test(val)) {
        let map = originalElementAttrs.get(el)
        if (!map) {
          map = new Map()
          originalElementAttrs.set(el, map)
        }
        map.set(attr, val)
        trackedElements.add(el)
      }
      const orig = originalElementAttrs.get(el)?.get(attr)
      if (orig !== undefined) {
        const nextVal = translateText(orig)
        if (el.getAttribute(attr) !== nextVal) {
          el.setAttribute(attr, nextVal)
        }
      }
    }
  }
}

export function setupDomI18n(): () => void {
  if (typeof document === 'undefined') return () => {}
  document.documentElement.lang = locale.value

  let syncing = false
  const apply = () => {
    if (syncing) return
    syncing = true
    try {
      processRootDom(document.body, locale.value)
    } finally {
      syncing = false
    }
  }

  const observer = new MutationObserver(() => {
    if (locale.value === 'en' && !syncing) {
      apply()
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })

  const stopWatch = watch(locale, async (next) => {
    document.documentElement.lang = next
    await nextTick()
    apply()
  }, { immediate: true })

  return () => {
    stopWatch()
    observer.disconnect()
  }
}
