# ContractGuard 任务报告

任务：acc79f8f-8bf0-46d6-8270-d6c21205e701

输入：consumer-demo-baseline.json → consumer-demo-candidate.json

模式：workflow · 状态：completed · 确定性结论：blocked

目标：检查此次发布的兼容性风险，结合调用方证据给出可验证的迁移建议。

版本：ContractGuard 1.5.0 / oasdiff 1.35.0

## 结果

检查完成：blocked。上游发现 2 项错误级兼容风险，0 项警告；调用方证据回归 3 项。

## 检查轨迹

| 证据 | 工具 | 状态 | 结果 |
|---|---|---|---|
| STEP-01 | validate-baseline | completed | baseline：0 条诊断，0 项错误级风险，0 项警告。 |
| STEP-02 | validate-candidate | completed | candidate：0 条诊断，0 项错误级风险，0 项警告。 |
| STEP-03 | breaking | completed | breaking：2 条诊断，2 项错误级风险，0 项警告。 |
| STEP-04 | changelog | completed | changelog：2 条诊断，2 项错误级风险，0 项警告。 |
| STEP-05 | native-analysis | completed | 原生规则：2 项破坏性变更，0 项待复核风险；调用方检查 4 项，回归 3 项。 |

## 上游诊断

- OAS-0001 · request-parameter-enum-value-removed · error：上游规则发现契约变化；请依据规则编号和操作位置确认兼容性影响。
- OAS-0002 · request-property-min-increased · error：上游规则发现契约变化；请依据规则编号和操作位置确认兼容性影响。

## 原生与调用方证据

原生破坏性变更 2 项；调用方回归 3 项。
- CG-0001 · SCHEMA\_ENUM\_NARROWED：An input enum accepts fewer values, or an output enum guarantees fewer possible values.
- CG-0002 · SCHEMA\_CONSTRAINT\_TIGHTENED：A schema accepts a smaller set of inputs or emits a broader set of outputs.

## 迁移建议

### 调用方 mobile-checkout 的迁移检查

证据：mobile-checkout:single-item-order:request, CG-0002

- Adapt Mobile checkout's request or retain provider acceptance for POST /orders; address the candidate validation issues.
- Re-run mobile-checkout:single-item-order:request with representative, sanitized baseline and candidate evidence; require a valid baseline and no candidate validation failures. Independently test the deployed integration.

### 调用方 mobile-checkout 的迁移检查

证据：mobile-checkout:single-item-order:response, CG-0002

- Restore the consumer response guarantees or migrate Mobile checkout's response handling for POST /orders; address the candidate validation issues.
- Re-run mobile-checkout:single-item-order:response with representative, sanitized baseline and candidate evidence; require a valid baseline and no candidate validation failures. Independently test the deployed integration.

### 调用方 inventory-sync 的迁移检查

证据：inventory-sync:sync-eu:request, CG-0001

- Adapt European inventory sync's request or retain provider acceptance for GET /inventory; address the candidate validation issues.
- Re-run inventory-sync:sync-eu:request with representative, sanitized baseline and candidate evidence; require a valid baseline and no candidate validation failures. Independently test the deployed integration.

### request-parameter-enum-value-removed

证据：OAS-0001

- 上游规则发现契约变化；请依据规则编号和操作位置确认兼容性影响。
- 确认受影响的调用方，保留兼容行为或安排版本迁移；补充变更前后调用样例后重新检查。

### request-property-min-increased

证据：OAS-0002

- 上游规则发现契约变化；请依据规则编号和操作位置确认兼容性影响。
- 确认受影响的调用方，保留兼容行为或安排版本迁移；补充变更前后调用样例后重新检查。

### SCHEMA\_ENUM\_NARROWED

证据：CG-0001

- 检查此规则对应位置的兼容行为，保留迁移窗口，并补充调用方回归样例。

### SCHEMA\_CONSTRAINT\_TIGHTENED

证据：CG-0002

- 检查此规则对应位置的兼容行为，保留迁移窗口，并补充调用方回归样例。

## 限制

- 仅分析提交的契约与调用样例；不访问实际服务，不修改代码，不证明生产环境完全兼容。
- 记录包含诊断信息与字段名称；原始契约、请求响应正文和模型原始回复不保存。

输入 SHA-256：

- baseline: 65265229e1044844eca304ef64a3a211c4829f50e85ec6d013ae2ceed601d9f1
- candidate: e57f07f0a455dd452fa7dfc4375f69f84a3cd953a15189f559c7ab8a8119eba6
