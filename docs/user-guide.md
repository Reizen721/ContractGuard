# ContractGuard 使用文档

当前版本为 **2.0.0**。完整步骤已整合到 [2.0 使用指南](v2.0-user-guide.md)，覆盖安装、网页操作、注册项目、已有测试、DeepSeek、MCP、CLI、历史升级和故障排查。

## 第一次使用

安装 Node.js 22.13+、pnpm 11.19.0 后，在仓库根目录运行：

```powershell
.\start-contractguard.bat --install --projects .\fixtures\project-tests\demo-registry.json --no-ai
```

打开 `http://127.0.0.1:8080`，在 Agent 工作区选择 `orders-migration`，运行 workflow 审查。这个示例会展示基线、候选与迁移补丁三阶段的真实测试，且不需要 API Key。

macOS/Linux 的安装与启动命令、自己的项目接入方式见[完整指南](v2.0-user-guide.md)。

## 按任务查找

| 任务 | 文档位置 |
| --- | --- |
| 安装及 Windows BAT | [环境与启动](v2.0-user-guide.md#2-安装和启动) |
| 了解三阶段测试 | [完整示例](v2.0-user-guide.md#3-跑通第一个完整示例) |
| 接入源码、fixtures 与已有 Node/Vitest 测试 | [项目注册](v2.0-user-guide.md#4-接入自己的本地项目) |
| 隐藏输入 DeepSeek Key | [模型配置](v2.0-user-guide.md#5-配置-deepseek) |
| 导入 Agent、下载 ZIP、共用历史 | [MCP 插件](v2.0-user-guide.md#6-在-codexantigravity-或其他-agent-中使用) |
| 脚本和 CI 门禁 | [CLI](v2.0-user-guide.md#7-cli-与-ci-使用) |
| 保留旧历史与回归包 | [升级](v2.0-user-guide.md#8-历史升级与验证) |
| 常见报错 | [排错表](v2.0-user-guide.md#9-常见问题) |

OpenAPI 官方规范：[总入口](https://spec.openapis.org/oas/)、[3.0.4](https://spec.openapis.org/oas/v3.0.4.html)、[3.1.2](https://spec.openapis.org/oas/v3.1.2.html)。历史 1.x 专题文档保留当时的实现背景，当前安装方式以 2.0 指南为准。
