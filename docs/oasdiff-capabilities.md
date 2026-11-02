# oasdiff 集成：范围、源码核对与使用

ContractGuard V1.5 通过固定版本的官方 oasdiff 可执行文件补足成熟的契约检查能力。在本地 CLI 中完整转发其命令和参数；在 Web / Agent 中，使用受限的离线执行入口。调用方证据、任务编排、中文迁移建议与报告保存由 ContractGuard 提供。

这意味着我们可以使用上游的完整开源 CLI，**不意味着 ContractGuard 独立重写了全部规则，也不意味着已经超越 oasdiff 的所有产品能力**。oasdiff.com 的托管审查、账号和商业服务不是本项目的实现内容。

## 固定版本与核对依据

| 项目 | 本次核对结果 |
| --- | --- |
| 上游仓库 | [oasdiff/oasdiff](https://github.com/oasdiff/oasdiff) |
| 固定版本 | [v1.35.0](https://github.com/oasdiff/oasdiff/releases/tag/v1.35.0) |
| 源码提交 | `a4ba100f880c7579765c5e63915a99bf1acc6967` |
| 核对方式 | 克隆该标签源码，阅读命令注册、参数、加载器、格式器和相关测试；运行同版官方二进制 |
| 变更检查目录 | `checks changelog --format json` 实际返回 **778** 个条目，包含不同严重程度的检查，并非 778 个破坏性规则 |
| 规范校验目录 | `checks validate --format json` 实际返回 **121** 个条目 |
| 校验与安装 | [版本及平台散列锁](../config/oasdiff-lock.json)、[安装器](../scripts/install-oasdiff.mjs) |
| 许可 | Apache-2.0，见 [第三方声明](../THIRD_PARTY_NOTICES.md) |

源码核对针对这个版本；后续版本需要重新验证，不以不断变化的 `main` 分支作为已实现能力的依据。上游规则数量也不是正确率或真实场景覆盖率的证明。

## 命令覆盖矩阵

下表的“CLI”指 `contractguard oasdiff <原生参数>`。它先检查引擎版本，再直接启动同一官方可执行文件，保留标准输入、标准输出、标准错误、工作目录、环境配置和退出码，不用 ContractGuard 自有规则模拟结果。

| 上游命令 / 能力 | ContractGuard CLI | Web / Agent 离线执行入口 | 对应上游源码 |
| --- | --- | --- | --- |
| `breaking` | 全部参数直通 | JSON；自动方言规范化；内部引用 | [breaking_changes.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/breaking_changes.go) |
| `changelog` | 全部参数直通 | JSON；同上 | [changelog.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/changelog.go) |
| `diff`、`summary` | 全部参数直通 | JSON；同上 | [diff.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/diff.go)、[summary.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/summary.go) |
| `validate` | 全部参数直通 | 分别校验基线 / 候选；JSON | [validate.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/validate.go) |
| `flatten`、`upgrade` | 全部参数直通 | 包内安全执行函数可用；是否作为页面操作以页面功能为准 | [flatten.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/flatten.go)、[upgrade.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/upgrade.go) |
| `breaking-files` | 完整上游 Git 行为 | 不开放本机 Git / 路径执行 | [breaking_files.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/breaking_files.go) |
| `git-diff-driver` | 完整上游 Git 差异驱动 | 不开放 | [git_diff_driver.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/git_diff_driver.go) |
| `checks changelog`、`checks validate` | 完整检查目录、筛选及输出 | 不接受任意目录命令 | [checks_changelog.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/checks_changelog.go)、[checks_validate.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/checks_validate.go) |
| `checks changelog coverage` | 覆盖目录、缺口 / 豁免模式 | 不开放 | [checks_coverage.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/checks_coverage.go) |
| `schema` | 变更 JSON 输出的 JSON Schema | 不开放 | [schema.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/schema.go) |
| `help`、`completion`、`--version` | 原生帮助、补全与版本 | 引擎状态由服务单独展示 | [run.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/run.go) |

“包内函数可用”不等于所有功能都已有独立页面或 REST 端点。Agent 只调用其任务流程所需的检查，避免把任意命令执行器暴露给模型或浏览器。

## 参数、输入和输出

CLI 直接交给上游解析参数，因此保留以下能力，而不在 ContractGuard 里维护一份易遗漏的参数白名单：

- 文件、URL、标准输入 `-`、Git 引用；外部引用、多文件加载、`--composed` 契约集合与 glob。
- 路径筛选、路径前缀增删、路径参数匹配、内联与引用匹配、HTTP 头名称比较、扩展字段过滤。
- `--auto-upgrade` 方言规范化、`--flatten-allof`、`--flatten-params`。
- 严重程度配置、错误 / 警告忽略文件、弃用天数、稳定性级别、扩展属性、模板、退出阈值。
- 显式 `--config`、`OASDIFF_CONFIG`、工作目录配置文件，以及上游已定义的环境变量。
- `--open` 和审查上传参数仍是上游行为：只有用户在本地 CLI 明确调用它们，才会触发上游服务。Agent 不使用这些参数。

参数的真实含义由 [cmd_flags.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/cmd_flags.go) 与 [viper.go](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/internal/viper.go) 决定。例如旧 `--include-checks` 已被上游弃用并忽略，`--max-circular-dep` 也不再生效；直通并不会把这些旧开关重新实现为新功能。

v1.35.0 的格式注册表包括 `yaml`、`json`、`text`、`markup`、`markdown`、`singleline`、`html`、`githubactions`、`junit`。**不同命令可用的格式不同**，以该命令的 `--help` 为准；该版本没有注册 SARIF 格式。支持的上游本地化语言是 `en`、`ru`、`pt-br`、`es`；中文解释由 ContractGuard 提供。[格式注册源码](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/formatters/interface.go)

## 离线执行边界

`@contractguard/oasdiff` 提供 `runPreparedOasdiff(command, { baseline, candidate }, options)`。它接受文档内容，不能从请求中接受可执行文件路径、任意命令参数或本地工作目录。

执行过程会解析上传内容，只把生成的 JSON 写入独立临时目录，使用固定的相对文件名。所有调用都设置 `--allow-external-refs=false`，使用独立空配置，并移除继承环境中的 `OASDIFF_*` 设置。比较命令额外开启 `--auto-upgrade`，排除内部打包存储扩展的重复差异；不会启用 `--flatten-allof`。

| 输入或限制 | 当前处理 |
| --- | --- |
| 单文档 | JSON / YAML / 对象；可将 3.2 文档提交上游解析。ContractGuard 自有规则的版本范围仍单独计算 |
| 本地多文件包 | 使用已有 3.0 / 3.1 显式文件包解析器，转换为内部引用；不读取上传清单外文件 |
| 3.2 多文件包 | 当前安全入口不支持；可先用合适的工具打包成单文档，或在本地 CLI 使用完整上游能力 |
| 外部引用 | 网络、文件 URI、磁盘路径和包目录逃逸均拒绝；不会自动下载缺失引用 |
| `$ref` 文本 | 安全检查保守扫描所有对象，包括示例内名为 `$ref` 的字段；含外部 `$ref` 字面值的示例也可能被拒绝 |
| 预算 | 单文档文本 5 MiB，展开 JSON 20 MiB，20 万值，128 层；文件包另遵守原有文件数 / 引用预算 |
| 子进程 | 无 shell；默认 60 秒、stdout 与 stderr 合计 8 MiB；可取消；失败后清理临时目录 |
| 输出位置 | `baseline.json` / `candidate.json` 的行列属于生成的 JSON，不应冒充原上传文件行列；原始证据定位使用 ContractGuard 自有来源映射 |
| 缺失 / 错误版本 | 显示引擎不可用并返回明确错误，不偷偷替换为自有引擎后继续宣称 oasdiff 已通过 |

模型不能更换引擎、增加命令参数、读取开发者本机文件或开启外部服务上传。完整 CLI 则是用户在自己机器上主动运行的工具，其权限与上游 CLI 一致。

上游本身也有覆盖限制。固定版本的文档指出，动态引用未完整解析、`components.pathItems` 的表示不完整，3.2 新增结构仍可能存在遗漏。`flatten-allof` 也有语义限制。集成成熟引擎不会自动消除这些问题；“没有发现问题”不等于契约已被数学证明兼容。[上游方言支持及限制](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/docs/OPENAPI-31.md)

## 安装与使用

在项目根目录运行：

```powershell
node scripts/install-oasdiff.mjs
pnpm.cmd build
pnpm.cmd contractguard oasdiff --version
pnpm.cmd contractguard oasdiff --help
pnpm.cmd contractguard oasdiff breaking fixtures/petstore-v1.yaml fixtures/petstore-v2-breaking.yaml --format json --fail-on ERR
pnpm.cmd contractguard oasdiff checks changelog --format json
pnpm.cmd contractguard oasdiff checks changelog coverage --format json
```

安装器按平台选择官方资产，支持 Windows / Linux 的 x64、arm64，以及 macOS 的通用二进制。它先核对固定 SHA-256，再从压缩包中仅提取指定普通可执行文件，禁止链接目标和路径展开。工具保存在 `.tools/oasdiff/1.35.0/`，不提交 Git。也可以由运维设置 `CONTRACTGUARD_OASDIFF_PATH` 指向同版本可执行文件；每次调用均检查版本。

`breaking` 默认未设置失败阈值时，可以同时输出破坏性发现和退出码 0。CI 若需阻止合并，应按需求设置 `--fail-on ERR` / `WARN`，不能只凭默认退出码判断结果。`validate` 的默认错误阈值下，0 表示未触发阈值，1 表示校验发现，102 表示加载失败。其它原生退出码也原样保留。

## 验证与维护

```powershell
pnpm.cmd --filter @contractguard/oasdiff test
```

包测试使用真实已安装引擎验证七个安全命令、固定目录数量、3.2 单文件、跨方言等价变更、多文件包、外部引用拒绝、环境配置隔离、运行 / 输出预算和取消；还检查版本不匹配、输入预算和压缩包提取。未安装引擎时，依赖真实引擎的用例会明确跳过，因此发布验收必须先安装引擎并确认这些用例实际执行。

升级上游时，需要同时更新锁文件和运行时版本常量，重新核对规则目录、命令帮助、输出格式、退出语义、许可证、CLI 对照结果以及安全执行测试。仅修改版本号不能证明新版本已完成验收。
