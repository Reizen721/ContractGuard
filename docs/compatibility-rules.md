# 兼容性规则 / Compatibility Rules

## 1. 兼容性的判定方向

ContractGuard 默认回答的是：**已经按照 baseline 编写的调用方，在服务端升级到 candidate 后，是否仍能正常工作？** 这是一种面向 API 提供方发布的向后兼容（provider backward compatibility）判断。

规则建立在两个集合关系上：

- **请求输入：** candidate 应继续接受 baseline 所允许的请求；收窄可接受输入通常会破坏旧客户端。
- **响应输出：** candidate 最好只返回 baseline 客户端已经知道如何处理的结果；扩大可能输出的范围可能破坏严格客户端。

例如，将请求字段的枚举从 `[A, B]` 扩大到 `[A, B, C]` 通常兼容，因为旧客户端仍然只发送 A/B；将响应枚举同样扩大却可能破坏旧客户端的穷举分支。这也是规则必须保留 request/response 上下文的原因。

## 2. 风险等级

| 等级 | 含义 | 推荐动作 |
| --- | --- | --- |
| `breaking` | 从规范层面可明确构造一个曾有效、现在无效的旧客户端交互 | 阻止发布，或采用新版本路径/迁移方案 |
| `potentially-breaking` | 影响取决于客户端生成方式、解析严格度或业务语义 | 人工评审并用消费者契约测试验证 |
| `non-breaking` | 在默认方向和已分析语义下通常保持旧客户端可用 | 可发布，但仍应运行集成测试 |
| `info` | 文档、弃用标记等不直接改变线上的结构契约 | 记录并通知维护者 |

“non-breaking”只表示**当前规则没有发现结构性破坏**，不代表业务行为、性能、授权策略或线上数据一定兼容。

ContractGuard 1.1.0 可以通过受校验的规则策略启停规则、覆盖 severity 和调整评分权重。本文列出的是默认语义；应用策略后的报告会记录策略 ID 与 SHA-256 指纹。配置和审计方法见[规则策略与输入指纹](./rule-policy.md)。

## 3. 规则目录

下表描述核心规则 ID 与默认口径。某些 schema 规则会根据其位于请求还是响应中给出不同等级。

### 3.1 路径与操作

| Rule ID | 变化 | 默认等级 | 理由 |
| --- | --- | --- | --- |
| `PATH_REMOVED` | 删除整个 path | `breaking` | 旧客户端无法再访问该资源 |
| `PATH_ADDED` | 新增 path | `non-breaking` | 不影响原有操作 |
| `OPERATION_REMOVED` | 删除某个 HTTP method | `breaking` | 旧调用方式不再存在 |
| `OPERATION_ADDED` | 在既有/新路径增加 method | `non-breaking` | 原操作仍保留 |

### 3.2 参数与请求体

| Rule ID | 变化 | 默认等级 | 说明 |
| --- | --- | --- | --- |
| `PARAMETER_REMOVED` | 删除既有参数定义 | `potentially-breaking` | 严格服务端可能拒绝旧客户端继续发送的参数 |
| `PARAMETER_ADDED_REQUIRED` | 新增必填参数 | `breaking` | 旧客户端不会发送它 |
| `PARAMETER_ADDED_OPTIONAL` | 新增可选参数 | `non-breaking` | 旧请求仍有效 |
| `PARAMETER_REQUIRED` | 参数由可选变为必填 | `breaking` | 旧请求可能缺失它 |
| `PARAMETER_OPTIONAL` | 参数由必填变为可选 | `non-breaking` | 扩大可接受请求集合 |
| `PARAMETER_SERIALIZATION_CHANGED` | 规范化后的 style、explode、allowReserved 或 content 媒体类型变化 | `potentially-breaking` | 相同参数值可能需要不同的线上编码；省略值与规范默认值等价时不报 |
| `REQUEST_BODY_REMOVED` | 删除既有请求体 | `potentially-breaking` | 旧客户端仍可能发送 body；具体取决于服务器 |
| `REQUEST_BODY_ADDED_REQUIRED` | 无 body 的操作新增必填 body | `breaking` | 旧请求无法满足新约束 |
| `REQUEST_BODY_ADDED_OPTIONAL` | 新增可选 body | `non-breaking` | 不要求旧客户端改变 |
| `REQUEST_BODY_REQUIRED` | body 由可选变为必填 | `breaking` | 旧请求可能不带 body |
| `REQUEST_BODY_OPTIONAL` | body 由必填变为可选 | `non-breaking` | 放宽请求条件 |
| `REQUEST_MEDIA_TYPE_REMOVED` | 删除一种可接受 Content-Type | `breaking` | 使用该媒体类型的旧请求失效 |
| `REQUEST_MEDIA_TYPE_ADDED` | 新增可接受 Content-Type | `non-breaking` | 扩大输入集合 |

路径参数按 OpenAPI 要求本来就应为 required；不合法的输入文档可能被解析器先拒绝，而不是产生兼容性条目。

### 3.3 响应

| Rule ID | 变化 | 默认等级 | 说明 |
| --- | --- | --- | --- |
| `RESPONSE_STATUS_REMOVED` | 删除已声明状态码 | 2xx 为 `breaking`；其他为 `potentially-breaking` | 可能改变成功/错误流程及生成 SDK 的返回类型 |
| `RESPONSE_STATUS_ADDED` | 新增可能状态码 | 2xx 为 `potentially-breaking`；其他为 `non-breaking` | 新成功分支可能需要客户端处理；补充错误文档本身不缩窄旧契约 |
| `RESPONSE_MEDIA_TYPE_REMOVED` | 删除既有响应媒体类型 | `breaking` | 客户端可能无法获得可解析表示 |
| `RESPONSE_MEDIA_TYPE_ADDED` | 新增响应媒体类型 | `non-breaking` | 在静态契约层面保留旧表示；实际内容协商仍需测试 |
| `RESPONSE_HEADER_REMOVED` | 删除响应头 | `potentially-breaking` | 客户端可能读取分页、限额等响应头，需核实消费者依赖 |
| `RESPONSE_HEADER_ADDED` | 新增响应头 | `non-breaking` | 保留原有响应头 |
| `RESPONSE_HEADER_SERIALIZATION_CHANGED` | 响应头的规范化序列化选项变化 | `potentially-breaking` | 旧客户端解析方式可能失效 |

状态码判断是结构性近似。把 `201` 改为 `200`，即使 body 相同，也可能影响依赖状态码的客户端；新增 `500` 声明并不意味着服务刚开始可能失败，因此需要结合运行语义审查。

V1.2 比较响应头时不区分名称大小写，忽略 OpenAPI `headers` 映射中没有效力的 `Content-Type` 项；头部 schema 的类型、枚举等变化继续使用既有方向性 Schema 规则，而不另造一套判断。

### 3.4 Schema 类型、枚举与属性

| Rule ID | 请求方向 | 响应方向 |
| --- | --- | --- |
| `SCHEMA_TYPE_CHANGED` | 类型变化通常 `breaking` | 类型变化通常 `breaking` |
| `SCHEMA_PRESENCE_CHANGED` | 从无约束 schema 变为有约束通常 `breaking` | 从有约束 schema 变为未指定通常 `breaking` |
| `SCHEMA_BOOLEAN_CHANGED` | 按 `true`/`false` 所代表的全集/空集方向判断 | 按输出集合的反方向判断 |
| `SCHEMA_ENUM_NARROWED` | `breaking`：曾可发送的值不再允许 | 通常 `non-breaking`：返回范围收窄 |
| `SCHEMA_ENUM_WIDENED` | `non-breaking`：接受更多输入 | `potentially-breaking`：客户端可能未知新值 |
| `SCHEMA_REQUIRED_PROPERTY_ADDED` | `breaking`：旧请求缺少新字段 | 通常 `non-breaking`：服务保证提供更多字段 |
| `SCHEMA_REQUIRED_PROPERTY_REMOVED` | `non-breaking`：放宽请求要求 | `breaking`：客户端依赖的字段可能缺失 |
| `SCHEMA_PROPERTY_REMOVED` | 取决于 candidate 的 `additionalProperties`：明确拒绝旧值时为 `breaking`，继续接受时为 `non-breaking`，不能证明则为潜在风险 | `breaking`：旧客户端可能读取该字段 |
| `SCHEMA_PROPERTY_ADDED` | 可选不代表兼容：对原本开放对象增加类型约束可能为 `breaking`；旧对象明确禁止该额外属性时通常兼容，复杂条件下人工复核 | 通常 `non-breaking`，严格解码器场景可人工升级为潜在风险 |
| `SCHEMA_CONSTRAINT_TIGHTENED` | `breaking`：如提高 `minLength`、降低 `maximum` | 通常放宽客户端预期，但需结合关键字判断 |
| `SCHEMA_CONSTRAINT_RELAXED` | `non-breaking`：接受更多输入 | 可能扩大实际输出集合，必要时标为 `potentially-breaking` |
| `SCHEMA_UNSUPPORTED_KEYWORD_CHANGED` | `const`、`format`、`not`、条件 schema 等尚不能精确证明集合关系时标为 `potentially-breaking` | 响应方向同样标为 `potentially-breaking` 并要求评审 |
| `SCHEMA_COMPOSITION_CHANGED` | 不能证明等价的 `oneOf`/`anyOf`/`allOf` 变化为 `potentially-breaking` | 同样人工复核，不按分支数量或数组位置推断安全 |

约束规则只在能够安全比较时触发。不同类型之间、正则表达式包含关系、复杂数组约束等无法仅靠数值大小判定的情况，不应伪装成精确结论。

V1.2 将 OpenAPI 3.0 的 `minimum` + 布尔 `exclusiveMinimum`（以及对应上界）与 OpenAPI 3.1 的独立数值边界归一为 `{value, exclusive}`。同时存在边界时使用较强约束；整数类型比较等价整数区间，避免 `> 0` 与 `>= 1` 的误报。

组合分支按有界、引用感知的语义签名比较，纯文档修改及等价重排不报；`oneOf` 的重复分支不能去重，因为它要求恰好匹配一支。不能证明等价或超出比较预算时会保守提示，而不是把更多分支当作安全扩展。这仍不是一般 Schema 包含关系求解器。

V1.3 进一步按方言处理类型和引用，以下修正可能改变旧版报告中的个别判断：

- OpenAPI 3.0 的 `nullable: true` 只有在同一 Schema 显式声明 `type` 时才加入 `null`；OpenAPI 3.1 使用 `type: [string, "null"]` 等联合类型，旧式 `nullable` 不生效并产生覆盖告警。
- `properties` 或 `items` 本身不等于声明 `type: object` 或 `type: array`，引擎不会据此补出类型。OpenAPI 3.0 的 `additionalProperties: true/false` 是合法的关键字值，与 3.1 的独立布尔 Schema 分开处理。
- 普通 Reference Object 在 3.0 中忽略 `$ref` 旁的其他字段，在 3.1 中只允许 `summary`、`description` 覆盖。3.1 Schema 的 `$ref` 相邻约束是合取：可证明的简单约束可合并，复杂情况保留 `allOf`，变化按 `SCHEMA_COMPOSITION_CHANGED` 等潜在风险处理，并提示分析范围有限。
- Path Item 有自己的引用语义：引用目标的 `get` 与本体的 `post` 可以共存；同名字段冲突且值不同时，规范没有定义合并结果。引擎会报告 `PATH_ITEM_REFERENCE_CONFLICT` 并停止对该路径作精确差异判断。

未知 `jsonSchemaDialect` / `$schema`、资源作用域和未实现的复杂关键字会进入覆盖提示；受未知方言或资源作用域影响的 Schema 不继续给出精确的安全判断。方言标识是解释依据，不表示已经实现该方言的所有验证语义。支持边界与可运行示例见 [V1.3 升级与多文件使用](./v1.3-upgrade.md)。

### 3.5 鉴权与元数据

| Rule ID | 变化 | 默认等级 |
| --- | --- | --- |
| `SECURITY_STRENGTHENED` | 从无鉴权到需要鉴权，或替代方案减少 | `breaking` |
| `SECURITY_RELAXED` | 减少要求或增加无需鉴权/更多可选方案 | `non-breaking` |
| `SECURITY_SCHEME_CHANGED` | 已使用方案的 type、API key 位置/名称或 HTTP scheme 改变时为 `breaking`；bearerFormat、OpenID URL 或 OAuth flows 等变化为 `potentially-breaking` | 动态等级 |
| `OPERATION_ID_CHANGED` | 修改 operationId | `potentially-breaking` |
| `DEPRECATED_ADDED` | 标记为 deprecated | `info` |
| `DEPRECATED_REMOVED` | 取消 deprecated 标记 | `non-breaking` |
| `METADATA_CHANGED` | summary、description、title 等文本变化 | `info` |

`operationId` 不影响裸 HTTP 请求，但会改变很多代码生成器产生的方法名，因此不能简单归为纯文档变化。

服务器 URL 变化暂不作为核心规则承诺：它显然可能影响部署与发现，但 URL 往往被环境配置、反向代理或 SDK base URL 覆盖。平台可展示该差异，发布门禁应由团队策略决定。

## 4. 位置与证据

每条变更应提供机器可读且便于人类定位的 `location`，例如：

```text
paths./pets.get.parameters.query.limit.required
paths./pets.post.requestBody.content.application/json
paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.id
```

`before` 与 `after` 仅保存解释该结论所需的值，避免把整份规范复制进每条结果。`recommendation` 应给出可执行建议，例如“先将字段作为 optional 发布，等待客户端完成迁移后再设为 required”。

V1.3 支持显式提交的本地多文件契约包。可定位时，`sourceLocations.old/new` 额外给出 `{ file, pointer }`，例如 `schemas/pet.yaml` 和 `#/properties/id/type`；原有 `location` 继续用于规则定位。合成位置无法一一映射时使用最近已知祖先，不提供推测的行号。来源元数据中的 `dialect` 说明方言，`bundle.entry` 与 `bundle.files` 记录入口和实际引用依赖的 SHA-256。只有入口及其传递依赖参与包指纹，文件列表顺序不影响结果；指纹用于核对输入身份，不证明契约内容正确。

多文件包必须显式包含所需文件，核心引擎不读取磁盘或访问网络。每包最多 50 个 YAML/JSON 文件，全部 `content` 的 UTF-8 大小合计最多 5 MiB。相对引用必须留在包内，并仅使用支持的文件路径与 JSON Pointer；缺失依赖、远程引用、命名 anchor 或需要 `$id` 资源基址解析的包引用会明确失败，不会作为“未发现变化”处理。

## 5. 分数与门禁

当前兼容性分数从 100 开始：每个 `breaking` 扣 12 分，每个 `potentially-breaking` 扣 4 分，最低为 0；`non-breaking` 和 `info` 不扣分。这个权重是可解释的展示启发式，不是经验概率。分数适合用来快速比较多个变更集，但不能用“85 分”抵消一个关键的 breaking 条目。未来调整权重时应提升引擎版本并更新评估记录。

CLI 的 `--fail-on` 决定进程退出状态：

- `breaking`：发现至少一个 `breaking` 时失败；
- `potentially-breaking`：发现 `breaking` 或 `potentially-breaking` 时失败；
- `never`：分析成功即返回成功，风险仅写入报告。

CI 中建议先使用 `breaking`，在规则基准集稳定后再逐步提高门槛。

V1.3 的 `coverage` 与以上严重等级和 `compatible` 独立。`complete` 只表示在已实现的分析范围内没有检测到已知覆盖告警；`partial` 表示有待人工核对的范围，不是准确率或覆盖百分比。告警带 `code`、`side`、`location`、说明和可选原文件来源，最多保留 100 条；`truncated: true` 表示告警数量或文本被截断。策略禁用规则或改变等级不会隐藏这些告警。旧历史没有 `coverage` 时应显示“未记录/未知”。

默认门禁仍由 `--fail-on` 控制，因此 `compatible: true` 可以与 `coverage.status: "partial"` 同时出现。希望未完整覆盖也阻止 CI 时，显式增加 `--fail-on-incomplete`；该选项在 coverage 为 partial 时返回退出码 2，即使没有 breaking。它不把覆盖告警改造成 breaking finding。

## 6. 示例解释

用 `fixtures/petstore-v1.yaml` 比较 `fixtures/petstore-v2-breaking.yaml`，预期至少覆盖以下风险：

- `/health` 被删除；
- `GET /pets` 的 `limit` 从 optional 变为 required；
- 新增必填请求头 `tenantId`；
- 请求参数 `tags` 的枚举被收窄；
- `POST /pets` 不再接受 `application/x-www-form-urlencoded`，同时新增 `application/xml`；
- `NewPet.ownerId` 成为新必填字段；
- 响应中的 `Pet.name` 被删除，`Pet.id` 从 integer 改为 string；
- 全局新增 API key 要求；
- `listPets` 的 operationId 被修改。

兼容样例则以新增可选查询参数、新增资源操作、扩大请求枚举和增加可选字段为主。它用于验证规则不会把所有文本差异都误报为 breaking。

## 7. 当前不覆盖或仅部分覆盖

- 远程 `$ref`、命名 anchor，以及需要 `$id` 资源基址解析的包引用；显式本地文件包中的相对文件 + JSON Pointer 引用已支持；
- 未知 Schema 方言、`$dynamicRef` / 动态作用域，以及未实现关键字的一般验证语义；
- 循环引用的完整语义等价判断；
- `oneOf`、`anyOf`、`allOf`、`not`、discriminator 的一般包含关系；
- 正则表达式语言包含关系；
- 回调、链接、webhook、multipart encoding 和服务器地址的完整客户端影响；
- Path Item 引用的同名字段冲突，以及超出递归或比较预算的语义；
- 业务错误码、速率限制、排序、分页语义和数据含义；
- 实际网关是否忽略未知参数，以及特定 SDK 的序列化/解码行为；
- 非 OpenAPI 描述的身份、权限、SLA 和性能变化。

V1.3 会对已识别的未覆盖范围给出 coverage 提示；扫描只沿契约语义位置进行，不把 `example`、`default` 中的业务 JSON 当作 Schema。输入错误和不支持的引用解析仍明确失败，不会一律转成 partial。遇到这些情况应结合消费者契约测试和人工评审。任何未来新增规则都应附带正例、反例和一个“无法确定”的边界用例。

## 8. 规则维护原则

1. 先写能构造反例的判定理由，再实现规则。
2. 对请求与响应分别测试，不能只替换提示文字。
3. 不确定时使用潜在风险或显式跳过，避免虚假精确。
4. 规则行为变化时提升引擎版本并更新 fixtures、测试和本文档。
5. 报告已知漏报和误报，不能只展示成功案例。

权威语法定义应以 [OpenAPI Specification](https://spec.openapis.org/oas/) 为准；本文描述的是 ContractGuard 的兼容策略，而不是 OpenAPI 标准的一部分。
