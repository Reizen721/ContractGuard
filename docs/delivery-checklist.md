# ContractGuard 2.0 交付清单

发布目标：**Reizen721/ContractGuard，v2.0.0**。实际标签、发布状态和下载附件以 [GitHub Releases](https://github.com/Reizen721/ContractGuard/releases) 为准。此清单说明交付内容；执行结果与环境限制单独记录于[验证索引](verification.md)。

## 程序与入口

| 交付 | 位置 / 使用方式 |
| --- | --- |
| Vue 网页工作台 | `apps/web`，构建后由本地 API 提供 |
| HTTP 服务与存储 | `apps/api`；契约分析、AI 解读、Agent 与调用方历史 |
| 命令行 | `apps/cli`；`pnpm contractguard --help` |
| 原生分析引擎 | `packages/core`；规则、方言规范化、本地多文件、coverage、样例证据与回归包 |
| 官方引擎集成 | `packages/oasdiff`；固定 oasdiff 1.35.0，独立于自有 2.0.0 版本 |
| 调用方迁移 | `packages/caller`；有限 TS 重放、源码位置、显式字段映射和候选 diff |
| 可信项目测试 | `packages/project`；注册表、快照、Node/Vitest 基线/候选/补丁执行 |
| MCP 服务及插件 | `packages/mcp`、`plugins/contractguard`；19 个工具，复用本地服务 |
| Windows 启动器 | [BAT](../start-contractguard.bat) 与 [PowerShell 实现](../scripts/start-contractguard.ps1) |

自有包、原生引擎、运行时与插件清单统一为 **2.0.0**，由 `pnpm versions:check` 校验。第三方包与演示项目保留它们自己的版本。

## 源码、文档与示例

| 交付 | 链接 |
| --- | --- |
| 默认英文 README | [README](../README.md) |
| 中文 README | [README.zh-CN](../README.zh-CN.md) |
| 完整使用文档 | [2.0 用户指南](v2.0-user-guide.md) · [使用文档入口](user-guide.md) |
| 双语发布页 | [中文](releases/v2.0.0.zh-CN.md) · [English](releases/v2.0.0.en.md) |
| 变更记录 | [CHANGELOG](../CHANGELOG.md) |
| 开发与接口 | [开发指南](development.md) · [架构](architecture.md) · [HTTP API](api-reference.md) |
| 规则与边界 | [规则目录](compatibility-rules.md) · [上游能力说明](oasdiff-capabilities.md) |
| 最小契约示例 | [旧契约](../fixtures/petstore-v1.yaml) · [破坏性候选](../fixtures/petstore-v2-breaking.yaml) |
| 多文件契约 | [基线入口](../fixtures/multifile/baseline/openapi.yaml) · [候选入口](../fixtures/multifile/candidate/openapi.yaml) |
| 调用方示例 | [调用方输入](../fixtures/caller-impact/input.json) |
| 完整迁移示例 | [订单项目注册表](../fixtures/project-tests/demo-registry.json) |
| 公开项目验证 | [注册表](../fixtures/project-tests/registry.json) · [方法和来源](v1.8-benchmark.md) |
| 可分享的配置模板 | [LLM 档案示例](../config/llm-providers.example.json) |
| 许可与来源 | [MIT](../LICENSE) · [第三方声明](../THIRD_PARTY_NOTICES.md) |

OpenAPI 官方规范链接保留在中英 README 与使用指南：[规范总入口](https://spec.openapis.org/oas/)、[3.0.4](https://spec.openapis.org/oas/v3.0.4.html)、[3.1.2](https://spec.openapis.org/oas/v3.1.2.html)。

## 发布附件

- `ContractGuard-Agent-Plugin-2.0.0.zip`：可移动插件运行文件、清单、使用 skill 和许可。需要 Node.js 22.13+ 及单独启动的 ContractGuard 服务，不是完整桌面安装程序。
- `SHA256SUMS.txt`：插件压缩包的 SHA-256 校验值。
- GitHub 标签源码归档：包含构建完整服务所需的源码、锁文件、文档和示例。下载后按使用指南安装和构建。

生成的宿主本机配置位于 `.tools/agent-plugin/`，包含绝对路径，应在使用机器上执行 `pnpm plugin:prepare` 生成；它不作为通用可移动配置直接发布。

## 验证入口

| 检查 | 命令 / 记录 |
| --- | --- |
| 构建、类型、单元和跨入口回归 | `pnpm check` |
| 发布版本一致性 | `pnpm versions:check`，已包含在 check |
| 旧包与旧历史升级 | `pnpm regression:v20`，已包含在 check |
| 公开项目对照 | `pnpm benchmark:v18` |
| 插件可移动打包 | `pnpm test:plugin`，已包含在 check |
| Codex 端到端接入 | `pnpm test:plugin:codex`；需要对应宿主环境 |
| 真实 DeepSeek | 可选 `pnpm acceptance:v18:deepseek`，实际云端调用，不在默认 check 中 |
| 历史真实模型记录 | [V1.8 DeepSeek 验收](v1.8-deepseek-acceptance.md)，不标为新版本重新调用 |

检查数量、跳过原因、实际页面验收和发布前执行结果见 [2.0 验证记录](v2.0-verification.md)与[验证索引](verification.md)。不把测试数量、示例通过或模型建议当作全面兼容性保证。

## 本地资料保留与升级

发布不包含 API Key、本地 provider/project 配置、个人绝对路径、历史数据库、测试输出或已安装依赖。模型 Key 通过启动器隐藏输入，只供服务进程使用。已有本地资料应由使用者自行保留。

`schemaVersion` 保持 1；旧的已完成历史不重写版本。回归包只显式兼容 1.5.0 与 2.0.0，保留原包 checksum，未知版本仍拒绝。更新后重新构建并重启服务，端口或运行路径改变时重新生成插件配置。

项目测试会执行可信 Node.js 程序，临时副本不是操作系统沙箱。迁移补丁不会自动应用到原项目，有限测试通过不清除原契约门禁。
