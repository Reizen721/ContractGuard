# REST API Reference

## 概览

V1.8 的 MCP 插件提供 **19 个工具**：保留 V1.6 的 14 个和 V1.7 的四个调用方工具，新增注册项目发现，并扩展完整审查中的源码和真实测试证据。它没有新增公网 `/mcp` 路由，也不复制存储；查询分页和导出分块在插件内完成，原有 HTTP 响应保持兼容。有限源码重放见[调用方迁移验证指南](v1.7-caller-migration.md)，V1.8 完整任务接口见本页下方。

V1.5 新增 `/api/agent/status` 与 `/api/agent/runs` 系列任务接口，支持提交、轮询、取消、恢复历史及导出；请求模型、执行边界和示例见 [V1.5 指南](v1.5-agent-workbench.md#api)和 [Agent 设计](agent-design.md)。原有 `/api/analyses` 保持自有单次分析行为，不会静默替换成上游规则引擎。

- 默认地址：`http://localhost:8080`
- API 前缀：`/api`
- 请求/响应编码：UTF-8
- 创建分析和 AI 解读时的 Content-Type：`application/json`
- 身份认证：本地版本未提供；默认仅限本机使用，不要直接暴露到不可信公网

API 接受 OpenAPI YAML/JSON **文本**、已经解析的 JSON **对象**，以及 V1.3 的**显式本地文件包**。浏览器选择本地文件后由前端读取文本，再作为 JSON 请求发送；当前接口不接受 `multipart/form-data`、ZIP 或供服务器任意读取的磁盘路径，也不抓取远程 `$ref`。

V1.4 可通过同一创建接口的 `consumerEvidence` 字段提交调用方样例和响应约束；省略时保留原有行为。AI 报告解释器默认关闭，只解释已有 finding 和有界调用方检查元数据，不改变严重等级、得分、`compatible` 或任何 CLI/CI 结果。启用云端模型后尤其需要在公网入口增加鉴权和限流，以防第三方滥用额度。

## 通用错误结构

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "baseline cannot be empty.",
    "details": {}
  }
}
```

`details` 仅在有额外结构化信息时出现。客户端应使用 `code` 处理错误，`message` 用于展示；不要依赖英文 message 的精确文本。

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| `200` | 查询或导出成功 |
| `201` | 分析创建并持久化成功 |
| `204` | 删除成功，无响应体 |
| `400` | JSON、请求字段、分析 ID、报告格式、OpenAPI 文档或调用方证据无效；非法证据为 `INVALID_CONSUMER_EVIDENCE` |
| `404` | 路由或分析记录不存在 |
| `413` | baseline/candidate 超出配置的单份输入大小，或整个 JSON 请求体过大 |
| `429` | 调用方审查并行 worker 已满，等待正在执行的任务完成后再提交 |
| `502` | AI 上游失败，或模型响应未通过结构校验 |
| `503` | AI 功能关闭或缺少必要配置 |
| `504` | AI 上游请求超时，或调用方审查超过执行时间限制 |
| `500` | 存储等意外服务端错误 |

## 数据模型

### Severity

```ts
type Severity =
  | 'breaking'
  | 'potentially-breaking'
  | 'non-breaking'
  | 'info';
```

### Change

```json
{
  "id": "CG-0001",
  "ruleId": "PARAMETER_REQUIRED",
  "severity": "breaking",
  "category": "parameter",
  "location": "paths./pets.get.parameters.query.limit",
  "message": "Query parameter limit became required.",
  "before": false,
  "after": true,
  "recommendation": "Keep the parameter optional until existing clients migrate."
}
```

`category` 为 `path`、`operation`、`parameter`、`request-body`、`response`、`schema`、`security` 或 `metadata`。

V1.3 可选字段 `sourceLocations` 保留多文件来源，例如：

```json
{
  "sourceLocations": {
    "old": { "file": "schemas/pet.yaml", "pointer": "#/properties/id/type" },
    "new": { "file": "schemas/pet.yaml", "pointer": "#/properties/id/type" }
  }
}
```

`location` 是引擎的逻辑位置，`pointer` 是原文件中的 JSON Pointer 片段，包含开头的 `#`；不要将两者拼接。新增/删除内容可能只有一侧来源，合成位置可能指向最近已知祖先；这些字段不承诺编辑器行号。无法定位时省略。

### StoredAnalysis

```json
{
  "id": "1e7fb7d1-5990-4a68-9f48-1d73e4691134",
  "baselineName": "petstore-v1.yaml",
  "candidateName": "petstore-v2.yaml",
  "createdAt": "2026-09-16T10:00:00.000Z",
  "engineVersion": "1.4.0",
  "generatedAt": "2026-09-16T10:00:00.000Z",
  "policy": {
    "id": "contractguard-default",
    "fingerprint": { "algorithm": "sha256", "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
  },
  "source": {
    "old": {
      "title": "ContractGuard Petstore",
      "version": "1.0.0",
      "openapi": "3.0.3",
      "dialect": "openapi-3.0",
      "fingerprint": { "algorithm": "sha256", "value": "1111111111111111111111111111111111111111111111111111111111111111" }
    },
    "new": {
      "title": "ContractGuard Petstore",
      "version": "2.0.0",
      "openapi": "3.0.3",
      "dialect": "openapi-3.0",
      "fingerprint": { "algorithm": "sha256", "value": "2222222222222222222222222222222222222222222222222222222222222222" }
    }
  },
  "score": 42,
  "compatible": false,
  "summary": {
    "total": 12,
    "breaking": 8,
    "potentiallyBreaking": 2,
    "nonBreaking": 1,
    "info": 1
  },
  "changes": [],
  "coverage": {
    "status": "complete",
    "warnings": [],
    "truncated": false
  }
}
```

上例中的分数和计数仅用于解释字段，不是对 fixture 的承诺结果。`compatible` 只在应用规则策略后没有 `breaking` 时为 `true`；仍可能存在 `potentially-breaking`。1.0.x 历史记录可能没有 `policy` 与 `source.*.fingerprint`，客户端应容忍缺失；字段语义见[规则策略与输入指纹](./rule-policy.md)。

V1.3 新结果保留 `source.old/new.dialect`。3.0 为 `openapi-3.0`，3.1 为声明的 `jsonSchemaDialect` 或默认的 `https://spec.openapis.org/oas/3.1/dialect/base`。标识不代表该方言的全部关键字均受支持。文件包还包含 `source.old/new.bundle`：

```ts
interface ContractBundleMetadata {
  entry: string;
  files: Array<{
    path: string;
    fingerprint: { algorithm: 'sha256'; value: string };
  }>;
}
```

`files` 只包含入口及实际传递依赖，按路径排序。各文件指纹按原始文本计算；包的 `source.*.fingerprint` 将入口、依赖路径和指纹一起计算。清单顺序或未使用文件不影响依赖身份，引用文件变化会影响它。指纹不是语义等价证明或可信来源签名。

### ConsumerImpactReport（V1.4，可选）

提交合法 `consumerEvidence` 时，`StoredAnalysis.consumerImpact` 保存独立结果。未提交证据或旧历史没有此字段时，调用方状态是“未评估”，不能推断为全部通过。示意结构如下；完整类型见 `packages/core/src/evidence-types.ts`。

```ts
interface ConsumerImpactReport {
  schemaVersion: 1;
  evidenceKind: 'supplied-examples';
  fingerprint: { algorithm: 'sha256'; value: string };
  summary: {
    consumers: number; interactions: number; checks: number;
    passed: number; regressions: number; invalidBaselines: number; inconclusive: number;
  };
  gate: 'pass' | 'review' | 'blocked';
  consumers: Array<{
    id: string; name: string; owner?: string; criticality: 'critical' | 'standard';
    checks: Array<{
      id: string; interactionId: string; name: string;
      kind: 'request' | 'response'; method: string; path: string;
      status: 'pass' | 'regression' | 'invalid-baseline' | 'inconclusive';
      baseline: { status: 'valid' | 'invalid' | 'unknown'; issues: Array<{code: string; path: string; message: string}>; truncated: boolean };
      candidate: { status: 'valid' | 'invalid' | 'unknown'; issues: Array<{code: string; path: string; message: string}>; truncated: boolean };
      relatedChangeIds: string[]; note: string;
    }>;
  }>;
  unmappedChangeIds: string[];
  migrationTasks: Array<{
    id: string; consumerId: string; owner?: string; priority: 'high' | 'normal';
    checkIds: string[]; changeIds: string[]; action: string; verification: string;
  }>;
  limitations: string[];
}
```

`blocked` 表示存在基线有效、候选违反已知条件的样例回归。没有回归但存在非法基线、无法确定的检查、未关联风险或静态 coverage 不完整时为 `review`；其余为 `pass`。这些状态仅针对明确提供的有限样例，**不修改**静态 `compatible`、严重等级或分数。未关联风险不代表接口无人使用，关联 change ID 也仅为操作级上下文而非因果证明。API 仍以 `201` 返回并保存成功完成的分析，即使 gate 为 blocked；HTTP 状态不是发布门禁。

报告保留检查元数据及样例指纹，不保存请求／响应原始 body 或 expectation。用户提交的数据不是系统从真实后端采集的观测结果。样例、已知支持范围与 CLI 门禁详见 [V1.4 指南](./v1.4-consumer-impact.md)。

### AnalysisCoverage

```ts
interface AnalysisCoverage {
  status: 'complete' | 'partial';
  warnings: Array<{
    code: string;
    side: 'old' | 'new';
    location: string;
    message: string;
    source?: { file: string; pointer: string };
  }>;
  truncated: boolean;
}
```

这是确定性分析的覆盖范围，与后文 `AiReview.coverage` 的 finding 发送数量不同。例如存在 webhook 时，结果可包含：

```json
{
  "status": "partial",
  "warnings": [
    {
      "code": "WEBHOOKS_NOT_ANALYSED",
      "side": "new",
      "location": "webhooks",
      "message": "Webhook compatibility is not analysed.",
      "source": { "file": "openapi.yaml", "pointer": "#/webhooks" }
    }
  ],
  "truncated": false
}
```

`complete` 表示当前实现范围内未发现已知覆盖告警，不是完整 OpenAPI 校验、准确率或形式化兼容证明。未知方言、复杂 Schema、资源作用域、Path Item 引用同名冲突、未分析的回调/webhook/encoding、递归预算等会导致 partial；受未知语义影响的位置不作精确安全判断。最多返回 100 条有界告警，数量或文本截断时 `truncated` 为 true。规则策略不会隐藏 coverage，`compatible: true` 与 partial 可以同时出现。旧历史可能没有 `coverage`、`dialect`、`bundle` 或 `sourceLocations`；缺少 coverage 必须按“未记录/未知”处理，不能填成 complete。

### AiReview

```ts
interface AiReview {
  id?: string; // V1.2 保存结果的 UUID
  language?: 'zh-CN' | 'en';
  focus?: string;
  coverage?: {
    totalFindings: number;
    includedFindings: number;
    omittedFindings: number;
    includedChangeIds: string[];
  };
  schemaVersion: '1.0';
  analysisId: string;
  provider: string;
  providerId: string;
  providerLabel: string;
  model: string;
  generatedAt: string;
  promptVersion: 'ai-explainer-v1' | 'ai-explainer-v2' | 'ai-explainer-v3' | 'ai-explainer-v4';
  overview: {
    headline: string;
    executiveSummary: string;
    riskLevel: 'critical' | 'high' | 'medium' | 'low';
  };
  keyRisks: Array<{
    changeId: string;
    title: string;
    explanation: string;
    affectedConsumers: string[];
    remediation: string;
    priority: 'P0' | 'P1' | 'P2';
  }>;
  migrationPlan: Array<{
    order: number;
    title: string;
    actions: string[];
    relatedChangeIds: string[];
  }>;
  testSuggestions: Array<{
    title: string;
    details: string;
    relatedChangeIds: string[];
  }>;
  caveats: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}
```

`overview.riskLevel` 与 `keyRisks.priority` 是模型生成的沟通字段，不是规则引擎 severity。客户端不得用它们替代确定性的发布门禁。`usage` 只在上游提供用量信息时出现。

V1.2 的新解读使用 `ai-explainer-v2`，返回实际输入集合的 `coverage`；所有模型引用必须位于 `includedChangeIds` 中。`id`、语言和关注点随保存结果返回。新增字段保持 optional，以便旧客户端或旧格式数据兼容；它们不是模型可以任意声明的证据。JSON 和引用校验不证明解释文字正确。

V1.4 新生成的解读使用 `ai-explainer-v4`，保留 V1.3 的覆盖状态、告警数量和有限告警代码，并增加调用方 gate、摘要、未关联风险数量及最多 16 条失败／待确认检查。检查上下文只含有界 ID、状态、问题代码及实际发送 finding 中的关联 ID；不发送原始样例、expectation、负责人或诊断全文，也不发送原始文件包或 finding 的完整 `before` / `after`。已保存 v1/v2/v3 解读保留原版本并可读取。调用方检查 ID 不能冒充 change ID，只有样例失败、没有静态 finding 时也不补造风险编号。

## `GET /api/health`

读取服务状态。

**Response `200`**

```json
{
  "status": "ok",
  "service": "contractguard-api",
  "version": "1.4.0"
}
```

该端点证明进程可以响应，不检查磁盘可写性或下游依赖，因此不是完整 readiness 保证。

## `GET /api/ai/status`

读取 AI 解释器的本地配置状态。该端点不会调用任何上游 LLM，也不会消耗 token。

**Response `200`**

```json
{
  "enabled": true,
  "configured": true,
  "available": true,
  "provider": "deepseek",
  "model": "deepseek-flash",
  "promptVersion": "ai-explainer-v4",
  "activeProfile": "deepseek-cloud",
  "activeProviderId": "deepseek-cloud",
  "defaultProviderId": "deepseek-cloud",
  "allowRequestProfileOverride": true,
  "allowRequestProviderOverride": true,
  "providers": [
    {
      "id": "deepseek-cloud",
      "label": "DeepSeek",
      "displayName": "DeepSeek",
      "provider": "deepseek",
      "model": "deepseek-flash",
      "enabled": true,
      "configured": true,
      "available": true,
      "local": false
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | JSON 总开关；旧模式对应 `CONTRACTGUARD_AI_ENABLED` |
| `configured` | boolean | 必要服务端配置是否完整 |
| `available` | boolean | 当前是否允许发起 AI 请求；不代表已探测上游健康状态 |
| `provider` | string | 活动档案的 provider 标识 |
| `model` | string | 活动档案的模型标识 |
| `promptVersion` | string | V1.4 新解读使用 `"ai-explainer-v4"`；旧报告保留原版本 |
| `activeProfile` / `defaultProviderId` | string | 默认档案 ID；`activeProviderId` 是兼容别名 |
| `allowRequestProfileOverride` | boolean | 请求能否选择另一个已启用档案；`allowRequestProviderOverride` 是兼容别名 |
| `providers` | array | 可展示的档案元数据与配置/可用状态；不会包含 URL 或密钥名称 |

此响应永远不包含 API key、`secretEnv` 或 base URL。不要把 `available: true` 当成账号余额、配额或网络连通性的保证。

## `GET /api/rules`

返回当前引擎公开的规则目录。

**Response `200`**

```json
{
  "rules": [
    {
      "id": "PATH_REMOVED",
      "title": "Path removed",
      "category": "path",
      "defaultSeverity": "breaking",
      "description": "A previously documented endpoint path is no longer available."
    }
  ]
}
```

部分 schema 规则会根据 request/response 上下文调整实际 severity；`defaultSeverity` 是目录中的基础值，不保证每次触发都相同。

## `POST /api/analyses`

创建并保存一次兼容性分析。

若 API 进程设置了 `CONTRACTGUARD_POLICY_CONFIG`，服务会对所有新分析应用启动时验证的规则策略；请求体不能覆盖策略。响应中的 `policy` 与输入 fingerprint 用于审计。未设置时使用 `contractguard-default`。详见[规则策略与输入指纹](./rule-policy.md)。

### Request body

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `baseline` | `string`、OpenAPI object 或 `OpenApiBundleInput` | 是 | 已发布/旧版契约 |
| `candidate` | `string`、OpenAPI object 或 `OpenApiBundleInput` | 是 | 候选/新版契约，可与 baseline 使用不同输入形式 |
| `baselineName` | `string`，最多 200 字符 | 否 | 显示名称；单文件默认 `baseline.yaml`，包默认入口名 |
| `candidateName` | `string`，最多 200 字符 | 否 | 显示名称；单文件默认 `candidate.yaml`，包默认入口名 |
| `consumerEvidence` | `ConsumerEvidence` object | 否 | 有界调用方样例与响应约束；不接受 JSON 字符串、磁盘路径或未知 envelope 字段 |

V1.4 拒绝不在此表中的顶层字段，避免将 `consumerEvidence` 的拼写错误静默忽略。证据无效时返回 `400 INVALID_CONSUMER_EVIDENCE`，不会创建成功历史记录。

以 JSON 对象提交的最小示例：

```json
{
  "baselineName": "v1.json",
  "candidateName": "v2.json",
  "baseline": {
    "openapi": "3.1.0",
    "info": { "title": "Example", "version": "1.0.0" },
    "paths": {}
  },
  "candidate": {
    "openapi": "3.1.0",
    "info": { "title": "Example", "version": "1.1.0" },
    "paths": {}
  }
}
```

以 YAML 文本提交时，`baseline`/`candidate` 是 JSON 字符串；换行必须按 JSON 规则编码。推荐由程序读取文件，而不是手工在 shell 中转义。

### 可选调用方证据

将以下对象作为 `consumerEvidence`，并同时提交具备对应操作和内容 Schema 的 `baseline` 与 `candidate`：

```json
{
  "schemaVersion": 1,
  "consumers": [{
    "id": "checkout", "name": "结算页面", "owner": "Web 团队", "criticality": "critical",
    "interactions": [{
      "id": "read-receipt", "method": "GET", "path": "/orders",
      "response": {
        "status": "200", "mediaType": "application/json",
        "baselineBody": {"receipt": "example-receipt"},
        "candidateBody": {},
        "expectation": {"type": "object", "required": ["receipt"], "properties": {"receipt": {"type": "string"}}}
      }
    }]
  }]
}
```

若服务端 Schema 允许 receipt 缺省，候选响应可能仍符合服务端文档，却违反调用方自己的必填约束；因此两份规范相同时也可能出现样例回归。完整可运行输入在 [`fixtures/consumer-impact/`](../fixtures/consumer-impact)，不能只提交上面的证据片段代替两份契约。

每个交互必须至少提供 `request` 或 `response`。`request` 支持 `parameters` 的 path/query/header/cookie 解码值，以及配套 `mediaType` 的可选 body；`response` 要求三位 status、mediaType、baselineBody 和 expectation，candidateBody 缺省明确为未提供证据。method 规范化为大写，媒体类型转为小写；路径必须精确匹配 OpenAPI 路径模板，不做 URL 猜测或路由发现。

证据最多 1 MiB、50 个调用方、200 个交互，并限制 JSON 值数量与深度。只接收有限、无环的 JSON 值；schemaVersion、封闭字段、ID 唯一性、大小写冲突等由核心校验。样例 Schema 校验不是完整 JSON Schema 引擎，未支持约束产生 unknown／inconclusive，具体子集见 [V1.4 指南](./v1.4-consumer-impact.md)。

### 显式多文件输入

```ts
interface OpenApiBundleInput {
  kind: 'bundle';
  entry: string;
  files: Array<{ path: string; content: string }>;
}
```

`entry` 和 `path` 是包内相对路径，`content` 必须是 YAML/JSON 文本。包对象只接受上述字段，每个文件项只接受 `path`、`content`。调用者必须提供全部引用依赖；服务端不会补读本地磁盘或下载缺失文件。以下完整请求演示包与单文件对象混合输入：

```json
{
  "baselineName": "released-package",
  "candidateName": "candidate.json",
  "baseline": {
    "kind": "bundle",
    "entry": "openapi.yaml",
    "files": [
      {
        "path": "openapi.yaml",
        "content": "openapi: 3.1.0\ninfo: { title: Example, version: 1.0.0 }\npaths:\n  /id:\n    get:\n      responses:\n        '200':\n          description: Identifier\n          content:\n            application/json:\n              schema: { $ref: './schemas/id.yaml' }\n"
      },
      { "path": "schemas/id.yaml", "content": "type: string\n" }
    ]
  },
  "candidate": {
    "openapi": "3.1.0",
    "info": { "title": "Example", "version": "1.1.0" },
    "paths": {
      "/id": {
        "get": {
          "responses": {
            "200": {
              "description": "Identifier",
              "content": { "application/json": { "schema": { "type": "integer" } } }
            }
          }
        }
      }
    }
  }
}
```

支持 `./schemas/id.yaml#/properties/value` 等相对文件 + JSON Pointer 引用，`../` 必须仍在包根内。拒绝重复或大小写冲突路径、绝对/驱动器/UNC 路径、反斜杠、远程 URL、百分号编码文件路径和查询串。命名 anchor 以及需要 `$id` 资源基址解析的包引用不受支持，会明确失败；独立单文档中未知资源语义可能以 coverage partial 提示，不应据此认为已实现通用 JSON Schema URI 解析。

每侧包最多 50 个文件，全部 `content` 的 UTF-8 大小合计最多 5 MiB。API 的 `CONTRACTGUARD_MAX_SPEC_BYTES` 同时约束每侧：文本按 UTF-8、OpenAPI 对象按序列化 JSON、文件包按 content 合计计数；调高配置不会取消核心包的 5 MiB 上限。V1.4 整体 JSON 请求体上限为 `2 * CONTRACTGUARD_MAX_SPEC_BYTES + 1 MiB + 64 KiB`，转义后的传输大小可能超过原始内容大小；consumerEvidence 仍单独受 1 MiB 上限约束。结构展开、引用数量与深度也受核心预算约束；失败不会创建成功历史记录。实际目录选择与 CLI 加载方式见 [V1.3 升级与多文件使用](./v1.3-upgrade.md)。

**Response `201`：** 完整 `StoredAnalysis`。

可能错误：

- `INVALID_REQUEST`：字段缺失、为空、类型错误或文件名过长；
- `SPEC_TOO_LARGE`：单份规范超过 `CONTRACTGUARD_MAX_SPEC_BYTES`；
- `REQUEST_TOO_LARGE`：整体 JSON 请求体超过 HTTP 限制（413）；
- `INVALID_BUNDLE`：文件包结构、路径、缺失依赖或资源作用域不受支持（400）；
- `BUNDLE_LIMIT_EXCEEDED`：超过核心文件包数量、内容或结构预算（400）；API 提前发现 content 超限时也可能是 `SPEC_TOO_LARGE`（413）；
- `INVALID_REFERENCE`（或更具体引用错误）：引用值、JSON Pointer 或引用形式无效（400）；
- `INVALID_OPENAPI_DOCUMENT`（或更具体解析错误）：规范无法解析、版本不受支持或结构不合法。

## `GET /api/analyses`

列出历史分析的轻量摘要，按 `createdAt` 从新到旧排列。响应不包含完整 `changes`，打开详情时再按 ID 查询。

V1.4 有调用方结果的条目另包含 `consumerGate`（blocked/review/pass）和 `consumerSummary`（与完整报告的调用方 summary 相同）。旧条目缺失这些字段时表示未记录调用方验证。不要只用静态 score 或 compatible 计算历史列表的发布状态：100 分仍可能伴随 blocked。

**Response `200`**

```json
{
  "analyses": [
    {
      "id": "1e7fb7d1-5990-4a68-9f48-1d73e4691134",
      "baselineName": "v1.yaml",
      "candidateName": "v2.yaml",
      "createdAt": "2026-09-16T10:00:00.000Z",
      "score": 74,
      "compatible": false,
      "summary": {
        "total": 5,
        "breaking": 1,
        "potentiallyBreaking": 1,
        "nonBreaking": 2,
        "info": 1
      }
    }
  ]
}
```

当前版本不提供分页或服务端筛选，适合本地、有限历史记录场景。

## `GET /api/analyses/{id}`

读取一次完整分析。

### Path parameter

- `id`：创建分析时返回的 UUID。

- **Response `200`：** `StoredAnalysis`。
- **Response `400`：** `INVALID_ANALYSIS_ID`。
- **Response `404`：** `ANALYSIS_NOT_FOUND`。

## `POST /api/analyses/{id}/ai-review`

让选定的服务端 LLM 档案对一次已经保存的确定性分析生成结构化解释。调用前必须在服务端显式启用并配置 AI。

V1.2 默认复用同一分析及相关配置下已保存的成功解读；先校验当前档案权限与配置，再查询缓存。`force: true` 跳过已保存结果、明确请求重新生成，但相同的进行中请求仍可合并。失败不会覆盖成功历史；缓存不跨分析复用，不将一种 Provider 的结果冒充另一种结果。

该接口不会重新分析 OpenAPI，也不会覆盖已保存记录。服务端不发送 baseline/candidate 原始文本，只发送分析名称和版本元数据、确定性摘要，以及最多 `defaults.maxChanges` 条经过裁剪的结构化 finding；旧 DeepSeek 模式使用 `CONTRACTGUARD_AI_MAX_CHANGES`。finding 不含原始 `before`/`after` 对象。

### Path parameter

- `id`：创建分析时返回的 UUID。

### Request body

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `language` | `"zh-CN"` 或 `"en"` | 否 | AI 解读的目标语言，默认 `zh-CN` |
| `focus` | string，最多 500 字符 | 否 | 希望优先说明的受众、风险或迁移目标 |
| `providerId` | string，最多 64 字符 | 否 | 服务端档案 ID；省略时使用 `activeProfile` |
| `force` | boolean | 否 | 默认 `false`；`true` 表示明确重新生成，可能再次产生费用 |

```json
{
  "language": "zh-CN",
  "focus": "优先解释 breaking 变化、旧客户端影响，以及可分阶段执行的迁移方案。",
  "providerId": "deepseek-cloud"
}
```

仓库内的同一请求体见 `examples/ai-review-request.json`。`focus` 只能影响解释角度，不能改变规则等级、分数、兼容性或 CI 行为。

**Response `200`**

```json
{
  "schemaVersion": "1.0",
  "analysisId": "1e7fb7d1-5990-4a68-9f48-1d73e4691134",
  "provider": "deepseek",
  "providerId": "deepseek-cloud",
  "providerLabel": "DeepSeek",
  "model": "deepseek-flash",
  "generatedAt": "2026-09-17T08:00:00.000Z",
  "promptVersion": "ai-explainer-v4",
  "overview": {
    "headline": "候选 API 包含需要阻止直接发布的破坏性变化",
    "executiveSummary": "多个既有调用方式将失效，应保留兼容路径并分阶段迁移消费者。",
    "riskLevel": "critical"
  },
  "keyRisks": [
    {
      "changeId": "CG-0001",
      "title": "既有客户端可能无法继续调用端点",
      "explanation": "规则引擎识别到已发布端点被删除。",
      "affectedConsumers": ["仍使用旧路径的 SDK 和直接 HTTP 调用方"],
      "remediation": "恢复旧路径，在迁移窗口内同时提供新旧版本。",
      "priority": "P0"
    }
  ],
  "migrationPlan": [
    {
      "order": 1,
      "title": "恢复兼容入口",
      "actions": ["恢复旧路径", "为旧路径增加弃用提示"],
      "relatedChangeIds": ["CG-0001"]
    }
  ],
  "testSuggestions": [
    {
      "title": "回归旧客户端调用",
      "details": "使用上一发布版 SDK 验证旧路径仍可访问。",
      "relatedChangeIds": ["CG-0001"]
    }
  ],
  "caveats": ["模型未获得运行时流量和客户端版本分布。"],
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 500,
    "totalTokens": 1700
  }
}
```

自然语言、排序和 token 数会随输入与模型变化；上例只演示结构。服务端会解析并验证模型的 JSON 输出，非法或空响应不会以 `200` 返回。

V1.2 的响应还包含保存的 `id`、`language`、可选 `focus` 和 `coverage`，例如：

```json
{
  "id": "c376bcc9-3f3c-481c-b9c1-4afbf549ea29",
  "language": "zh-CN",
  "coverage": {
    "totalFindings": 12,
    "includedFindings": 1,
    "omittedFindings": 11,
    "includedChangeIds": ["CG-0001"]
  }
}
```

这是新增字段片段，不是完整响应。coverage 为 1/12 时，只能说模型收到了一条 finding，不能说它完整解释了所有十二条。服务端会提示裁剪与需要人工核对的情况，但不会用硬编码风险等级冒充模型意见。

可能错误：

| HTTP | `error.code` | 原因 |
| --- | --- | --- |
| `400` | `INVALID_JSON` | 标记为 JSON 的请求体不是合法 JSON |
| `400` | `INVALID_AI_REVIEW_REQUEST` | 请求体、未知字段、language、focus、providerId 或 force 不符合约束 |
| `400` | `AI_PROVIDER_OVERRIDE_DISABLED` | 服务端不允许覆盖活动档案 |
| `400` | `AI_PROVIDER_NOT_FOUND` | 档案 ID 未配置 |
| `404` | `ANALYSIS_NOT_FOUND` | 分析 ID 不存在 |
| `503` | `AI_DISABLED` | AI 开关未启用 |
| `503` | `AI_PROVIDER_DISABLED` | 目标档案已禁用 |
| `503` | `AI_NOT_CONFIGURED` | 未配置 API key 等必要参数 |
| `504` | `AI_UPSTREAM_TIMEOUT` | 调用所选 LLM 或读取响应超时 |
| `502` | `AI_UPSTREAM_UNAVAILABLE` | 网络层无法连接所选 LLM |
| `502` | `AI_UPSTREAM_ERROR` | 所选 LLM 返回非成功状态，或响应无法读取 |
| `502` | `AI_INVALID_RESPONSE` | 模型输出无法解析或未通过本地 schema 校验 |

502/504 响应不会使原始 `StoredAnalysis` 失效。客户端应继续展示确定性报告，并允许用户稍后手动重试；不要在无限循环中自动重试付费请求。

## `GET /api/analyses/{id}/ai-reviews`

读取该分析已保存的 AI 解读，按保存时间从新到旧返回 `{ "reviews": [...] }`。没有解读时为 `[]`，分析不存在时为 `404 ANALYSIS_NOT_FOUND`。读取历史不调用上游，不要求当前启用 AI 或具备 key。

解读保存于 `CONTRACTGUARD_DATA_DIR/ai-reviews/{analysisId}/{reviewId}.json`，与平铺分析文件分开。文件中的私有缓存键是配置身份的 SHA-256，不包含明文凭据，也不作为公共 API 字段返回。相同请求复用会保留原来的 ID、生成时间与用量；历史 usage 不是此次读取产生的新增费用。

## `GET /api/analyses/{id}/ai-reviews/{reviewId}/report`

下载一个已保存解读，`format=json`（默认）或 `format=markdown`。响应分别为 `application/json; charset=utf-8` 或 `text/markdown; charset=utf-8`，并设置附件文件名。

内容包含模型与提示词版本、关注点、证据覆盖和结构化解读，不含原始 OpenAPI 或密钥。下载历史不调用模型。分享 Markdown 前仍应检查其中的内部名称；模型文字不应作为可信 HTML 执行。

- 无效解读 ID：`400 INVALID_AI_REVIEW_ID`。
- 不支持的格式：`400 INVALID_REPORT_FORMAT`。
- 分析不存在：`404 ANALYSIS_NOT_FOUND`。
- 解读不存在：`404 AI_REVIEW_NOT_FOUND`。

## `GET /api/analyses/{id}/report`

下载分析报告。

### Query parameter

| 字段 | 值 | 默认 |
| --- | --- | --- |
| `format` | `json`、`markdown`、`html` | `json` |

响应具有 `Content-Disposition: attachment`，建议文件名为 `contractguard-{id}.{ext}`。

| format | Content-Type |
| --- | --- |
| `json` | `application/json; charset=utf-8` |
| `markdown` | `text/markdown; charset=utf-8` |
| `html` | `text/html; charset=utf-8` |

HTML 为自包含静态报告。输入规范中的文本会被转义，但分享前仍应检查是否含内部信息。

- **Response `400`：** `INVALID_REPORT_FORMAT` 或无效 ID。
- **Response `404`：** `ANALYSIS_NOT_FOUND`。

## `DELETE /api/analyses/{id}`

删除本地分析记录及关联的已保存 AI 解读，同时取消该分析正在进行的解读生成，防止完成后重新产生孤立记录。

- **Response `204`：** 已删除，无响应体。
- **Response `400`：** `INVALID_ANALYSIS_ID`。
- **Response `404`：** `ANALYSIS_NOT_FOUND`。

该操作不可通过 API 撤销，但不会修改 baseline/candidate 的原始文件。

## 调用方源码审查（V1.7）

这组接口使用独立的 `caller-reviews/` 历史。V1.8 Agent 调用相同解释器并在这里保存完整记录，同时在 Agent 报告中保留关联 ID。此接口本身执行有限 TypeScript AST 解释器，不运行提交源码、项目测试或真实 HTTP 请求。无需模型配置；实际项目测试通过下方注册项目审查执行。

| 方法与路径 | 请求 / 成功响应 |
| --- | --- |
| `POST /api/caller-reviews` | 接收完整 `CallerImpactInput`；`201` 返回 `{id, createdAt, report}` |
| `GET /api/caller-reviews` | `200` 返回 `{reviews: [...]}`，最新在前的摘要数组 |
| `GET /api/caller-reviews/:id` | `200` 返回保存的完整记录 |
| `GET /api/caller-reviews/:id/report?format=json` | `200` 返回完整 JSON 记录；`format=markdown` 返回带记录 ID 和时间的 Markdown |

输入字段为 `schemaVersion: 1`、`baseline`、`candidate`、`files`、`scenarios` 和可选 `fieldRenames`。`files` 显式包含 `{path, content}`；`scenarios` 指定导出函数、参数、操作、两侧响应和明确的预期值。源码路径是相对来源标识，不会作为服务器磁盘路径读取。完整输入、字段说明和直接可用的 PowerShell 示例见 [V1.7 指南](v1.7-caller-migration.md)与[自包含 fixture](../fixtures/caller-impact/input.json)。

`report` 包含 `toolVersion`、`evidenceKind`、`inputFingerprint`、`sourceFiles`、原始 `contractAnalysis`、`callsites`、`checks`、`patches`、`summary`、`gate` 和 `limitations`。历史摘要保留 ID、创建时间、版本、来源指纹、统计与门禁，不返回完整补丁。JSON API 导出保留 `{id, createdAt, report}` envelope；CLI 的 JSON 输出则是其中的 `report`。

每项检查可能为 `pass / regression / invalid-baseline / inconclusive`。候选补丁只在内存副本中生成并验证；`verified` 不会清除原静态风险或原始回归，也不会自动写回调用方项目。报告可能含候选源码、路径和样例观测值，不能因为未保存完整输入包就视为不含业务材料。

执行 worker 最多两个并行，每次最多 15 秒。请求断开会取消仍在进行的解释；如果在保存阶段断开，结果可能已经入库，客户端应先检查历史再决定是否重试。服务关闭时终止尚在运行的 worker。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_CALLER_INPUT` | 400 | 字段、源码包、场景、映射或预算不符合输入要求 |
| `INVALID_CALLER_REVIEW_ID` | 400 | ID 不是 UUID |
| `CALLER_REPORT_FORMAT` | 400 | format 不是 json 或 markdown |
| `CALLER_REVIEW_NOT_FOUND` | 404 | 指定记录不存在 |
| `CALLER_REPORT_TOO_LARGE` | 413 | 完整报告超过 16 MiB，未保存成功记录 |
| `CALLER_SERVICE_BUSY` | 429 | worker 并行数量已满 |
| `CALLER_REVIEW_CANCELLED` | 499 | 执行已取消；连接关闭时客户端通常收不到这个响应 |
| `CALLER_SERVICE_CLOSED` | 503 | 服务正在关闭 |
| `CALLER_REVIEW_TIMEOUT` | 504 | 执行超过时间限制，未保存成功记录 |
| `CALLER_ENGINE_ERROR` | 500 | worker 或引擎未完成，内部细节不对外暴露 |
| `CALLER_RECORD_UNREADABLE` | 500 | 指定历史记录损坏或不可读 |

契约解析错误沿用 core 的公开错误码；其他存储意外错误返回 `CALLER_INTERNAL_ERROR`。历史列表会跳过损坏记录，直接读取损坏 ID 则明确报错。

## 普通分析调用示例

### PowerShell

```powershell
$body = @{
  baseline = Get-Content -Raw fixtures/petstore-v1.yaml
  candidate = Get-Content -Raw fixtures/petstore-v2-breaking.yaml
  baselineName = 'petstore-v1.yaml'
  candidateName = 'petstore-v2-breaking.yaml'
} | ConvertTo-Json

$analysis = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8080/api/analyses `
  -ContentType 'application/json' `
  -Body $body

$analysis.summary

# Optional: requires an enabled, server-configured LLM profile.
$aiReview = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:8080/api/analyses/$($analysis.id)/ai-review" `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"language":"zh-CN","focus":"优先说明 breaking 变化和迁移顺序"}'

$aiReview.overview
```

PowerShell 在较旧版本中对嵌套对象的默认 JSON 深度较低；本例的规范是字符串，因此不受影响。若直接提交对象，应为 `ConvertTo-Json` 指定足够的 `-Depth`。

### JavaScript

```js
const response = await fetch('http://localhost:8080/api/analyses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    baseline: baselineText,
    candidate: candidateText,
    baselineName: 'openapi-v1.yaml',
    candidateName: 'openapi-v2.yaml'
  })
});

if (!response.ok) {
  const problem = await response.json();
  throw new Error(problem.error?.message ?? `HTTP ${response.status}`);
}

const analysis = await response.json();
console.log(analysis.summary);
```

## 限制与版本策略

当前 API 是本地项目接口，没有承诺长期稳定的外部 SaaS 版本策略。客户端应至少固定项目版本，并对未知响应字段保持容忍。规则语义发生变化时会提升 `engineVersion`；AI 结构由 `schemaVersion`、提示模板由 `promptVersion` 标识。HTTP 路由或响应发生不兼容变化时应引入显式 API 版本前缀或提升对应 schema 版本，而不是静默替换。

AI 输出含生成式内容，不适合作为稳定字符串接口。自动化系统应读取确定性 `StoredAnalysis`；若消费 AI 响应，只依赖记录在 `schemaVersion` 中的结构，并对缺省 `usage` 和新增字段保持容忍。


## V1.8 内置 Agent、调用方迁移与已有测试

### `GET /api/agent/projects`

只列出操作者通过 `projectConfigPath` 或 `CONTRACTGUARD_PROJECT_CONFIG` 注册的可信项目。未配置时返回空数组；配置损坏时返回明确错误，不伪装成不存在。返回不含根目录、可执行命令或依赖目录。

```json
{"projects":[{"id":"orders-migration","label":"订单调用方迁移","runner":"node-test","testsEnabled":true}]}
```

### `POST /api/agent/runs`

保留旧版显式 `baseline` / `candidate`、`consumerEvidence`、名称、目标及模型设置。V1.8 支持以下二选一的输入方式：

```json
{"projectId":"orders-migration","mode":"workflow","goal":"检查调用方迁移并运行已有测试"}
```

项目方式由服务端读取注册的契约、源码、JSON fixtures、预期文件与测试配置，并冻结为一次任务快照。`projectId` 不能与契约、调用方材料、命令、路径或其他配置覆盖一起提交。项目不存在或配置无效时不会创建成功任务。

显式方式可增加 `caller`：

```json
{
  "baseline": {"openapi":"3.0.3","info":{"title":"API","version":"1"},"paths":{}},
  "candidate": {"openapi":"3.0.3","info":{"title":"API","version":"2"},"paths":{}},
  "caller": {
    "files": [{"path":"client.ts","content":"export async function load() { return 1; }"}],
    "scenarios": []
  },
  "mode":"workflow"
}
```

该极小结构示例没有有效调用场景，只能产生待复核结论。真实调用方示例可以从 [V1.7 输入](../fixtures/caller-impact/input.json)中将 `files`、`scenarios`、`fieldRenames` 移入 `caller`，保留外层两份契约。`caller` 内不能再提交契约或 `schemaVersion`，避免两条检查使用不同版本。源码、场景和字段映射沿用 V1.7 验证与数量限制。

两种方式均返回 `202` 和已排队的任务。`mode:"workflow"` 不调用模型；`mode:"llm"` 使用服务器配置的模型编排相同必要工具。携带 caller 时，`caller-analysis` 成为必要检查；选择注册项目时，`project-tests` 也成为必要检查，并在 caller 检查之后执行。模型没有路径、命令或工具参数权限，不能跳过必要检查或改写确定性门禁。

### V1.8 任务结果新增字段

| 字段 | 含义 |
| --- | --- |
| `requiredTools` | 本次实际要求完成的工具；旧历史缺省按原有五步解释 |
| `project` | 已注册项目 ID、名称、runner、测试文件、源文件哈希和快照指纹，不含原始绝对根目录 |
| `inputFingerprints.caller` / `.project` | 调用方材料及项目快照的一致性指纹；不是数字签名 |
| `callerReview.id` | 保存到共享 `caller-reviews/` 的完整报告 ID，可用原有调用方接口查询 |
| `callerReview.summary` / `.gate` | 有限 AST 重放统计及原始门禁 |
| `callerReview.checks` / `.patches` | 有界状态摘要，ID 加 `CALLER-` 前缀；原始 ID 分别保留为 `sourceCheckId` / `sourcePatchId` |
| `projectTests` | `evidenceKind:"project-test-execution"` 的真实项目测试记录 |

`projectTests` 包含 `baseline`、`candidate` 和有补丁时的 `patched` 阶段，每阶段记录状态、退出码、通过/失败/跳过/总数、时长、有界输出及截断状态。报告还保留 runner、测试文件、快照指纹、补丁 ID、整体 `status` 与 `patchStatus`。阶段证据 ID 固定为 `PROJECT-BASELINE`、`PROJECT-CANDIDATE`、`PROJECT-PATCHED`，与 AST 重放结果区分。

- `status: pass`：选定的基线与候选测试满足执行器通过条件；不是对整个项目覆盖的保证。
- `regression`：有效基线通过，候选测试出现可确认的失败；原始门禁阻断。
- `invalid-baseline`：原基线已经失败，不能算新回归。
- `inconclusive`：测试未完成、缺少有效计数、测试集合不一致、超时或其他执行范围不足。
- `patchStatus: verified`：候选补丁在相同选定测试中满足执行器复验条件；保留原始回归和静态契约门禁。
- `failed` / `unverified` / `not-proposed`：补丁失败、证据不足或未提出补丁，不能显示为已修复。

模型观察仅包含固定说明、状态、计数和已知证据 ID；源文件、响应正文、补丁源码、测试输出不发送给内置 LLM。完整 caller 报告和真实测试输出保存在本地，可能包含项目私有数据。外部 MCP 宿主如何处理读取的结果由该宿主决定。

### 项目执行与错误边界

真实 Node/Vitest 测试仅来自本机配置中明确标记 `trusted:true` 的项目。使用固定 runner 和参数、独立源码副本、超时/取消/输出预算，默认不继承模型密钥；不自动安装依赖，不修改原项目。**它不是操作系统安全沙箱：可信测试代码仍可能使用网络或产生自身副作用。** HTTP/MCP 无法注册新项目、上传可执行测试或给出任意执行命令。

请求 JSON 总上限默认为 20 MiB（`2 * maxSpecBytes + 10 MiB`），契约每侧、源码和场景仍分别验证。MCP 请求同为 20 MiB；完整工具响应超过 256 KiB 时要求分页或分块导出，不静默截断。

项目配置不可读返回 `503 PROJECT_REGISTRY_UNAVAILABLE`，未知项目返回 `404 PROJECT_NOT_FOUND`，路径/配置/补丁不合法返回 `400` 对应项目错误；非法 Agent 组合返回 `400 INVALID_AGENT_INPUT`。已排队执行中的工具错误保存在任务终态中。取消会中止运行检查，迟到结果不能把取消任务改成成功。服务重启将未完成任务标记为 interrupted，不假装保留未持久化的原输入快照。

### MCP 增量

新增 `contractguard_list_projects`，沿用 `offset` / `limit` 分页。原 `contractguard_start_review` 接受上述两种输入，`contractguard_get_review` 新增 `callerChecks`、`callerPatches`、`projectTests` 三个 section。overview 返回关联 caller ID、快照和测试摘要，不返回测试正文；需要时分页读取 `projectTests` 或完整导出。原 18 个工具继续可用，普通分析、完整 Agent 审查、调用方详细报告仍各有记录 ID，并通过关联字段连接。
