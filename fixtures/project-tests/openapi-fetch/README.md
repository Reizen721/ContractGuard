# openapi-fetch：真实上游测试的受控响应变更基准

来源：[openapi-ts/openapi-typescript](https://github.com/openapi-ts/openapi-typescript)，固定提交 `d46a319ae2efab30e135ba9b223a3cffd1a67eab`，其中 `packages/openapi-fetch` 的版本为 0.17.0，MIT 许可证见 [LICENSE](LICENSE)。下载 URL、原始 SHA-256 与修改说明保存在 [provenance.json](provenance.json)。

## 哪些内容来自上游

- `src/index.js`：完整客户端运行时代码，未改动。
- `test/http-methods/get.test.ts`：原有五项 GET 测试，未改动任何断言或测试代码。
- `test/http-methods/schemas/get.d.ts` 和 `package.json`：保留原件；没有运行 package 脚本或安装该项目声明的依赖。
- `upstream/helpers.ts`：测试 helper 原件。工作副本 `test/helpers.ts` 增加了一个公开的 JSON 驱动响应变更适配器。
- `upstream/get.yaml`：原始 OpenAPI 文件。它描述 `Post.id`，而对应成功返回测试使用 `title/body/publish_date`；不能假称两者完全一致。

## 哪些内容由 ContractGuard 编写

`contracts/` 是按上述运行时测试观测编写的窄范围契约 profile，不是上游历史发布的契约。`modes/` 描述受控响应变更：字段改名、状态码变化、值变化、未覆盖路径及对照。`test/helpers.ts` 只在已注入的本地 fetch handler 返回结果后应用这些变更。`vitest.config.mjs` 只运行原来的五个 GET runtime 测试，不运行上游完整类型、构建、导出或浏览器测试。

五个测试都使用 helper 注入的本地函数返回 `Response`，不会请求真实业务服务。`https://fake-api.example` 只用于构造符合 Node 要求的 `Request` URL。没有云模型参与基准。

## 使用

在 ContractGuard 仓库根目录构建后执行：

```sh
node scripts/benchmark-v18.mjs --output ../ContractGuard-v18-benchmark
```

输出目录必须不存在。脚本会核对上游原件哈希，分别独立运行 Vitest、执行固定 oasdiff，以及通过真实 HTTP/MCP 提交内置 Agent 任务。所有测试都在临时副本中运行，原源码、断言和响应模式文件保持不变。

项目注册表是上一级 [registry.json](../registry.json)。这些样例明确标记为操作者信任的本地测试；普通 Node 子进程不是操作系统沙箱，不适用于未经审查的任意外部代码。

## 结论边界

这是**真实开源客户端及其既有测试上的受控变异实验**，不是六次真实线上事故，也不是六个独立真实项目。没有测量人工耗时、生产准确率、全语言覆盖或修复成功率。本组复杂客户端不受有限 AST 重放器支持，因此不生成自动补丁；项目测试仍能提供独立的执行证据。完整方法和结果见 [V1.8 基准说明](../../../docs/v1.8-benchmark.md)。
