# ContractGuard MCP：产品定位与同类方案

迭代补充：后续 [V1.7](v1.7-caller-migration.md) 已实现有限 TypeScript 源码定位、AST 样例重放及显式字段改名补丁验证。它尚不等同于本文建议的真实项目测试执行和经过生产案例对照的迁移闭环；以下竞品与创新性判断仍以 V1.6 为评估基线。

核查日期：2026-11-02。对象为本地 V1.6 实现及当日可访问的官方文档、项目仓库；本次调研没有购买或运行竞品，也没有做同场准确率、性能或用户规模测量。这是一份定位分析，不是市场穷尽调查。

## 结论

**当前 ContractGuard MCP 是有实际工程价值的 API 变更审查产品，但现有证据不足以称它为突破性产品。** MCP 接入、变更检测、调用方契约、AI 解释、迁移建议和历史查询均已有先行方案；其中一些产品已将多项能力组合提供。

可以确认的成果是：ContractGuard 将已有网页和分析服务开放给 Agent，通过同一套工具保存、查询和导出有证据的审查结果，并完成了真实宿主验证。不能从这点推出“首次实现”“没有竞品”“已经超过 oasdiff/PactFlow”。

建议对外定位：

> ContractGuard MCP 是面向 AI 编程助手的本地 API 变更审查后端。它组合确定性兼容性检查、用户提供的调用方样例与可追溯记录，让 Agent 执行审查、解释风险并整理迁移建议。

这里的“可追溯”指记录 ID、来源指纹、检查结果和证据引用；不是不可篡改的合规审计系统。

## 先明确：现在的产品是什么

外部 Agent 理解任务并读取获授权的文件，MCP 插件把材料提交给本机服务。普通分析执行原生规则及可选调用方样例检查；完整审查再组合上游 oasdiff，返回结构化证据。内置 DeepSeek 可选择参与报告解释或受限规划。它不是任意执行代码的通用自主 Agent。

当前具备 14 个工具、共享网页历史、报告导出、异步审查与取消、多文件输入、覆盖范围提示、AI 引用校验。调用方证据需要显式提交；尚不自动扫描客户端仓库、采集生产流量、验证真实服务行为或生成经过测试的迁移补丁。实现与边界见[插件指南](v1.6-agent-plugin.md)及[调用方证据设计](v1.4-consumer-impact.md)。

## 已存在的同类产品

| 产品 / 项目 | 官方材料已确认的重叠能力 | 对 ContractGuard 定位的影响 |
| --- | --- | --- |
| **oasdiff 官方 MCP** | 四项工具提供破坏性变更、changelog、结构 diff 与规范校验；使用远程 Streamable HTTP，接收自包含规范。[官方文档](https://www.oasdiff.com/docs/mcp) | “Agent 能直接分析 API 变化”已有直接实现。ContractGuard 完整审查还复用了其引擎，需明确归功于上游。 |
| **SpecShield MCP** | 六项工具覆盖发布判断、变化解释、迁移指南、发布说明、规范比较与治理审查；stdio 适配器连接其后端，需要 API Key。[官方仓库](https://github.com/specshield-io/specshield-mcp-server) | 最接近“Agent 帮助判断变更并给迁移建议”的定位。该组合不能宣称首创；其实际质量和部署采用情况本次没有实测。 |
| **Pact / PactFlow / Swagger Contract Testing** | Pact 的验证矩阵及 `can-i-deploy` 连接消费者、提供者版本与部署环境；Swagger Contract Testing 已提供 AI skills、SmartBear MCP 和贯穿双向契约测试的 Agent。[部署判断](https://docs.pact.io/pact_broker/can_i_deploy)、[AI 集成](https://support.smartbear.com/swagger/contract-testing/docs/en/user-guide/features/ai/ai-skills.html) | 调用方影响与 AI 编排已有成熟生态。ContractGuard 的有限样例校验尚不等同于真实消费者测试和提供者验证。 |
| **Bump.sh** | 已有变更管理和 CI breaking gate；Docs MCP 的 `list_changes`、`get_change` 允许 Agent 查询变更历史。[变更管理](https://docs.bump.sh/help/changes-management/)、[GitHub 集成](https://docs.bump.sh/help/continuous-integration/github-actions/)、[MCP 工具](https://docs.bump.sh/help/documentation-experience/ask-ai-capabilities/) | “让 Agent 查看 API 历史”也已有实现。其 Docs MCP 当前限公开文档/Hub；与本地私有材料审查的部署方式不同。 |
| **Speakeasy** | 规范 PR 可触发下游 SDK 预览 PR，展示方法、签名及类型变化；另有 OpenAPI 到 MCP 的生成能力。[SDK 预览](https://www.speakeasy.com/docs/sdks/guides/sdk-preview-breaking-changes)、[MCP 生成](https://www.speakeasy.com/docs/standalone-mcp/overview) | 生成 SDK 及更新 PR 不是空白方向。其 MCP 生成功能主要把 API 暴露为可调用工具，应与兼容性分析 MCP 区分。 |
| **MCP API Guardian** | 提供本地 `audit_openapi`、`compare_openapi`，覆盖部分路径、参数和鉴权变化，并明确比较范围有限。[官方仓库](https://github.com/petrovicistefan/mcp-api-guardian) | 本地、无 API Key、Agent 调用也不是独有组合；不能仅凭工具数量比较检测质量。 |
| **OpenAPI Contracts MCP Server** | 提供 `diff_contracts`、`validate_compatibility`，管理 provider/consumer 契约；diff 实现调用 `openapi-diff`。[官方仓库](https://github.com/apodi/openapi-contracts-mcp-server)、[实现](https://github.com/apodi/openapi-contracts-mcp-server/blob/main/src/tools/diff.tool.ts) | 已有另一条“成熟 diff 引擎 + 契约管理 + MCP”的实现路径；本次源码核查不能替代完整质量评估。 |
| **Swagger Testcase MCP** | 规范比较、验证、测试生成、缺失测试建议及导出。[官方仓库](https://github.com/eyaushev/swagger-testcase-mcp) | 比较与测试辅助的结合也已有先例。仓库存在说明有实现，不等于已获得生产可靠性证明。 |

不能把产品的 MCP 工具清单当作整个产品的能力上限。例如 oasdiff Pro 已有逐项批准/拒绝和 GitHub 合并门禁；不能写“oasdiff 只有 diff、没有审查流程”。[oasdiff Pro 官方说明](https://www.oasdiff.com/docs/setup)

历史参照还包括 Optic：它已有 diff/lint 和从测试流量推导规范的能力，但其官方仓库于 2026-01-12 归档，应按历史方案看待。[官方仓库](https://github.com/opticdev/optic)

## ContractGuard 目前值得展示的部分

这些是本仓库已实现的特点，不是经调查证明的独占功能。

1. **同一结果可以跨入口继续使用。** Agent 创建的记录能在网页查看，网页已有记录也能由 Agent 查询。历史、AI 解读和导出围绕同一服务组织。
2. **规则结论与生成式文字分开。** 规则及发布门禁不由模型随意改写，AI 建议引用实际检查证据。引用有效并不保证文字推理一定正确。
3. **检查范围和不确定性显式保留。** 样例失败、无效基线与无法确定分开记录，未覆盖范围不会被包装成“已通过”。
4. **可本地运行并复用已有引擎。** 安装上游引擎后，确定性工作流不依赖第二次云模型调用；使用云端 Agent 时，输入和工具结果仍可能被该宿主发送至云端。
5. **有真实接入证据。** Codex 与 Antigravity/Gemini 使用同一十例得到一致的保存结果，Harness 也完成冒烟测试；不是仅展示工具注册或静态界面。

但目前安装仍涉及 Node、pnpm、源码构建、引擎、独立 API 服务和宿主配置。“比竞品轻量、接入更快”需要从新用户的安装成功率和耗时来证明，不能仅凭本地优先的架构判断。

## 怎样评价“突破性”

| 维度 | 当前可支持的判断 |
| --- | --- |
| 技术原理 | 复用成熟 diff、样例验证和 MCP 协议；没有证据表明提出了新的兼容性判定方法。 |
| 功能新颖性 | 已有多款产品覆盖主要单项和组合；可以强调实现与取舍，不能强调首创。 |
| 工程完整度 | 已有多入口、任务状态、持久化、证据校验、错误处理与实际宿主测试，是成立的工程成果。 |
| 效果优势 | 尚无统一竞品基准、真实调用方故障集或审查耗时对照，无法证明更准、更快。 |
| 市场突破 | 尚无真实团队持续采用、复用率或需求访谈数据，无法据此判断产品市场匹配。 |

现有十例包括六个明确破坏、一个潜在风险和三个兼容变更，主要用于验证功能及宿主一致性。Codex 的失败会话、Gemini UI 提取限制、仅合成输入等边界均保留在[验证记录](verification.md)。它们不是对竞品的优势实验。

## 最值得继续做的方向

以下是基于现有实现和竞品材料的开发建议，**不是已经完成的功能，也不是已证实无人解决的市场空缺**。

### 1. 从变更定位到真实调用点

先限定 TypeScript 的少数稳定模式，例如 `fetch`/Axios 调用、响应字段访问和状态枚举分支。输入旧/新契约及一个获授权的调用方仓库，输出具体文件、行号、受影响字段和证据来源。无法解析的动态调用标为未知，不猜测受影响消费者数量。

验收应使用人工标注的实际调用点，测量定位准确率、漏报和未知比例。不要只增加更多单字段契约 fixture。

### 2. 从迁移建议推进到可执行验证

对已定位的调用方生成最小失败样例，在受限测试环境中实际运行，保存命令、退出码、输出、输入指纹及版本。随后对少数明确模式提出补丁，展示修改前失败、修改后通过的对照；未经执行的建议保留“未验证”状态。

价值是把“可能破坏某个调用方”推进到“这个版本的这段代码，在这个输入下确实失败”。这比增加另一份自然语言总结更容易形成可衡量的改进。

### 3. 连接已有证据，做公开基准

接受 Pact 验证结果、SDK 构建结果和团队现有测试产物，记录 commit、环境、时间及覆盖范围。证据缺失或过期时保持未知。优先复用已有发布矩阵，而非重建一个缩小版 Pact Broker。

建立公开对照集，区分“规范规则检测”“真实调用方定位”“迁移验证”“人工审查时间”。比较工具版本、配置和输入保持一致；用真实 API 演进及人工标注结果评估误报、漏报与可复现程度。只有这种证据才能支持后续的领先主张。

## GitHub 与作品集应如何表述

当前推荐的简短介绍是：**“通过 MCP 为编程 Agent 提供本地 API 变更分析、调用方样例检查和可追溯审查报告。”**

作品集中可以展示：领域规则与上游引擎集成、MCP 工具设计、异步任务控制、证据校验、持久化、跨宿主验收及失败分析。应区分自研部分和上游能力，避免“全面覆盖 OpenAPI”“自主验证所有调用方”“彻底消除幻觉”“全球首款”等缺乏证据的表述。

配套发布页见[中文草稿](releases/v1.6.0.zh-CN.md)与[英文草稿](releases/v1.6.0.en.md)。
