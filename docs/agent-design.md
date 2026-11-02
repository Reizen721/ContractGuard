# 本地 API 迁移任务 Agent

版本说明：以下主体记录 V1.5 的原始工具流程。V1.8 已把调用方源码分析和已登记可信项目测试纳入内置 Agent 的必要步骤；同一任务保存关联的调用方记录与真实测试证据。新的执行与数据边界以 [V1.8 指南](v1.8-project-agent.md) 为准，项目测试会实际运行可信代码，不再适用下文仅针对 V1.5 的“不执行项目代码”范围。

V1.5 的任务 Agent 接受两份 API 契约和可选的调用方样例，完成校验、兼容性检查、调用方影响分析和迁移建议，并保留可下载的检查记录。它面向发布前的离线审查：例如服务端将订单最小数量从 1 改成 2，契约规则能发现约束收紧，调用方样例则能指出哪个实际提交的单件订单会失败。

## 两种执行方式

| 模式 | 谁选择下一步 | 是否调用模型 | 适用情况 |
|---|---|---|---|
| `workflow` | 程序按固定顺序执行必要检查 | 否 | 默认模式、CI、本地审查、尚未配置模型 |
| `llm` | 模型根据已完成检查的有限观察选择下一项工具，服务器校验选择 | 是 | 需要根据证据补充结构检查，并生成带引用的迁移建议 |

`workflow` 是自动化工作流。`llm` 是受约束的工具选择循环，两者在报告中明确区分。原有的“AI 报告解释器”只解释已经完成的一份报告；这里的模型还会选择下一项允许的检查。即使模型给出乐观解释，也不能改变程序计算的 `verdict`。

Agent 第一阶段不修改调用方源码、不执行用户提供的命令、不访问实际 API 服务、不上传 GitHub、不安装依赖，也不执行模型提供的 URL。它验证的是提交的样例，不会把未提交的生产流量当成已覆盖。

## 工具和完成条件

1. 分别调用固定版本 oasdiff 校验基线和候选契约。两份都必须校验。
2. 契约有效后，必须运行 oasdiff `breaking`、`changelog`，以及 ContractGuard 原生规则和调用方证据检查。
3. 模型可选择额外的 `summary`、`diff`，各执行最多一次。只保存其结构统计和输出指纹，不保存完整差异正文。
4. 必要检查完成后才能 `finish`。契约无效时，在两次校验后结束并给出 `blocked`，不会继续生成无效的比较结果。

模型只能返回工具名、简短公开动作说明，以及结束时的摘要和建议。它没有工具参数权限，不能替换契约、可执行文件路径、配置或模型 URL。每次请求的 schema 只列出当时可用的工具，普通工具步骤应返回 null 摘要和空建议，空字符串摘要也按未提供处理。无效 JSON、重复或不可用工具、过早结束、虚构证据不会执行；云端适配器最多反馈校验原因并请求纠错一次，仍不合法则终止任务。鉴权失败、响应超限和取消不触发纠错。步骤记录不保存模型隐藏推理或原始回复。

oasdiff 固定为 **1.35.0**。不存在或版本不符时任务失败，不会悄悄改成只运行原生规则。上游 breaking 的退出码 0 不代表没有风险，结果依据 JSON 诊断的严重程度计算。标准输入不传给子进程；服务端将明确提交的内容放入临时工作目录，使用固定命令参数和关闭外部引用的配置执行，结束后清理临时文件。

OpenAPI 3.2 单文件可由上游引擎处理；原生引擎尚不支持时，报告保留上游结果，明确标记原生及调用方检查不可用，结论至少为 `review`。多文件输入沿用 ContractGuard 本地 bundle 能力，目前按 3.0/3.1 的支持范围处理。

## 任务状态与发布结论

`status` 表示执行过程：`queued` → `running` → `completed`；另外有 `failed`、`cancelled`、`interrupted`。`completed` 只说明检查流程结束。

`verdict` 独立表示已有证据的结论：

- `blocked`：契约校验失败、上游错误级兼容风险、原生破坏性变更或调用方回归。
- `review`：仍有警告、原生潜在风险、覆盖缺口、诊断截断、缺失调用方证据、原生检查不可用或未完成检查。
- `pass`：所有必要检查完成，没有上述风险，提交的调用方证据通过。它仍只适用于本次有限输入，不是对整个生产系统的证明。

步骤工具故障、模型故障不会生成成功报告。任务失败前已经发现的阻断风险仍可保留 `blocked`；其他不完整任务为 `review`。取消任务不能当作完成验收。

## 资源与数据边界

- 单进程并发 1，排队及运行任务合计最多 20；每个任务最多 7 个不重复工具、最多 8 次有效模型决策（包含结束），每次决策最多纠错一次，合计最多 16 次模型请求，plannerCalls 计入纠错请求。总时间预算仍为 240 秒。子进程和模型请求可以中断，原生同步检查另外受输入和结构预算约束。
- 每次上游工具时限 60 秒、输出上限 4 MiB；一次模型决策及其纠错共用服务端配置与 60 秒中的较小时限，单次响应上限取配置与 128 KiB 中的较小值。
- 每份契约内容最多 5 MiB；bundle 的序列化输入允许最多 6 MiB，但实际文件内容总和仍受 5 MiB 限制。调用方证据最多 1 MiB，并沿用原生证据结构校验。
- 每份持久化报告最多 4 MiB，保存最多 200 条上游诊断和 200 条原生变更明细；原生结果中的单个文本最多 1000 字符、明细数组最多 200 项。截断时保留完整计数并要求复核；若仍超出报告预算，移除分析明细并保存最小失败记录。每个任务目录最多 500 份报告，到上限后需要先归档旧报告。
- 原始契约、调用样例的请求响应正文及 expectation、上游完整 stdout/stderr、模型原始回复和 API Key 不写入任务历史。报告保留输入指纹、用户填写的文件名称和目标、诊断字段名、规则编号、检查状态和建议。上游诊断正文可能插入私有枚举值，因此统一转换为固定说明；原生变更消息也使用固定规则目录说明，删除 before/after 片段。路径与字段名称仍可能属于项目内部信息，历史文件应按项目资料管理。
- 模型只接收目标、受限的诊断摘要和检查计数、已知证据编号、工具动作记录和剩余限制；不接收原始契约或调用样例。应避免在目标或文件名称中填写密钥与私人数据。
- API Key、模型地址和可用 provider 来自服务端现有 LLM 配置；请求不能直接提交 key、地址或任意 provider 配置。配置是否允许切换 profile，由服务端决定。模型请求禁止跟随重定向。

报告用临时文件加原子重命名保存，步骤完成后写入进度。读取、列表和等待接口先等待已排队写入完成，最终保存失败时不会提前发布成功状态。原始输入只在内存排队或运行期间保留。进程重启后，历史中未完成的任务标记为 `interrupted`，不会自动恢复，也不会假装持有原始输入。取消会中止运行工具、清理待执行输入，迟到结果不能覆盖已取消状态。

**每个任务数据目录应由一个 AgentManager 进程使用。** API 与 CLI 默认使用不同目录。当前实现没有多进程调度或跨机器锁；不要让两个服务实例共用同一个任务目录。生产化的共享部署需要数据库任务队列、身份认证、租户隔离与专门的保留策略，这些不属于本地版本的已实现能力。

## API 与代码入口

| 接口 | 用途 |
|---|---|
| `GET /api/agent/status` | 查询引擎、模型配置可用性和资源限制 |
| `POST /api/agent/runs` | 提交任务，返回 202 和 `queued` 记录 |
| `GET /api/agent/runs` | 返回 `{ runs: [...] }` 历史摘要 |
| `GET /api/agent/runs/:id` | 查询进度、结果和证据 |
| `POST /api/agent/runs/:id/cancel` | 取消任务，重复取消已结束任务不会重跑 |
| `GET /api/agent/runs/:id/report?format=json` | 下载完整记录 |
| `GET /api/agent/runs/:id/report?format=markdown` | 下载便于审阅的说明 |

提交字段是 `baseline`、`candidate`、可选的 `baselineName`、`candidateName`、`consumerEvidence`、`goal`、`mode` 和 `providerId`。默认 `mode` 为 `workflow`；`providerId` 只能在 `llm` 模式使用。多文件契约沿用 `{ kind: 'bundle', entry, files: [{path, content}] }` 输入，不接受服务端文件路径或远程下载指令。

`apps/api/src/agent/manager.ts` 导出 `AgentManager`、输入及输出类型、`formatAgentReportMarkdown`。构造函数不创建目录或启动引擎；`submit/get/list/wait` 才初始化历史。`close()` 取消本实例的活动任务，API 服务关闭与 CLI 退出时均应调用。

## 可运行演示输入

`fixtures/agent/` 包含一个订单约束收紧案例：

- `baseline.json`：订单 `quantity >= 1`。
- `candidate.json`：修改为 `quantity >= 2`。
- `consumers.json`：同一零售调用方提供单件和批量订单；单件订单预期出现回归，批量订单仍通过。
- `invalid-path.json`：路径缺少开头斜线，用来演示契约校验阻断。

在页面中选择前三个文件并启动自动检查，无需模型密钥。预期看到上游最小值收紧诊断、原生规则风险、两项请求样例检查（1 项回归、1 项通过），最终结论 `blocked`。将候选文件换成基线文件，保持调用方证据不变，可验证 `pass` 的对照组；移除调用方证据则是 `review`。

也可在仓库根目录用 PowerShell 调用运行中的 API：

```powershell
$taskInput = @{
  baseline = Get-Content -LiteralPath '.\fixtures\agent\baseline.json' -Raw
  candidate = Get-Content -LiteralPath '.\fixtures\agent\candidate.json' -Raw
  consumerEvidence = Get-Content -LiteralPath '.\fixtures\agent\consumers.json' -Raw | ConvertFrom-Json
  baselineName = 'orders-v1'
  candidateName = 'orders-v2'
  mode = 'workflow'
  goal = '检查零售单件订单升级后是否仍然可用，并整理迁移事项。'
}
$json = $taskInput | ConvertTo-Json -Depth 100
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$run = Invoke-RestMethod -Method Post -Uri 'http://localhost:8080/api/agent/runs' -ContentType 'application/json; charset=utf-8' -Body $bytes
Invoke-RestMethod -Uri ('http://localhost:8080/api/agent/runs/' + $run.id)
```

若本机 API 使用其他端口，将示例中的 `8080` 改为启动日志中的端口。希望让模型参与时，先按现有 LLM 配置文档启用服务端 profile，再将 `mode` 改为 `llm`。这会实际调用配置的云端模型并产生对应费用。不要把 API Key 放进任务输入。

## 验证方式与边界

`apps/api/src/agent.test.ts` 使用注入的本地 runner 和 mock 模型，验证 workflow/LLM 的区别、必要工具强制执行、工具白名单、取消与迟到结果、队列上限、重启恢复、未知证据编号拒绝、隐私保存、3.2 降级、HTTP 报告下载和云适配器结构。原生消费者分析使用真实实现。测试不调用云模型。

oasdiff 包有独立的真实二进制测试，固定版本功能和真实 Agent 联调记录见当前版本的验证文档。模拟模型通过只说明循环、格式和权限边界有效，不等价于真实云模型的推荐质量评测。证据编号校验能防止引用不存在的检查，但不能证明模型建议在语义上正确；迁移建议仍需项目负责人审阅。
