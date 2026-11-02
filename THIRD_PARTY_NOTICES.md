# Third-party notices

ContractGuard's own source is licensed under the repository's [MIT license](LICENSE). Third-party software keeps its original license.

## Public-project benchmark and test runner

V1.8 includes selected source and existing tests from [openapi-ts/openapi-typescript](https://github.com/openapi-ts/openapi-typescript/tree/d46a319ae2efab30e135ba9b223a3cffd1a67eab), pinned to commit `d46a319ae2efab30e135ba9b223a3cffd1a67eab`. Upstream ownership and the unchanged [MIT license](fixtures/project-tests/openapi-fetch/LICENSE) are retained. The [provenance manifest](fixtures/project-tests/openapi-fetch/provenance.json) records original URLs and hashes. The local response-mutation helper is a disclosed benchmark adaptation; ContractGuard does not claim authorship of the upstream client or assertions.

Actual project tests may use the installed Vitest runtime, whose package retains its original license and dependencies. The MCP portable adapter does not bundle the project test runner; it connects to the local API service.

## TypeScript parser

The V1.7 caller module uses the [TypeScript compiler API](https://github.com/microsoft/TypeScript) to parse submitted source text. TypeScript is licensed under Apache-2.0; the installed package includes its license and notices. Its parser is upstream software; ContractGuard's bounded interpreter, evidence model and migration workflow are separate implementation work. The MCP adapter still connects over HTTP and does not itself bundle the caller parser.

## oasdiff integration

- Project: [oasdiff/oasdiff](https://github.com/oasdiff/oasdiff)
- Integrated version: **v1.35.0**
- Source revision: [`a4ba100f880c7579765c5e63915a99bf1acc6967`](https://github.com/oasdiff/oasdiff/tree/a4ba100f880c7579765c5e63915a99bf1acc6967)
- License: **Apache License 2.0**; the unchanged full license is included in [third_party/oasdiff/LICENSE](third_party/oasdiff/LICENSE).
- Copyright and authorship: the oasdiff authors and contributors; ContractGuard does not claim authorship of oasdiff's rules, parser, commands, or renderers.

ContractGuard invokes the **unmodified official executable** as a subprocess. `scripts/install-oasdiff.mjs` downloads a release asset and verifies its SHA-256 against `config/oasdiff-lock.json`. No upstream Go source is incorporated into ContractGuard's TypeScript engine. The executable is installed locally under `.tools/`, which is excluded from Git. A Docker image that installs this integration redistributes the executable together with this notice and the upstream license.

No separate `NOTICE` file was present in the pinned source checkout. This integration does not change the licensing of dependencies included in upstream release binaries. Consult the [pinned upstream source and dependency manifest](https://github.com/oasdiff/oasdiff/blob/a4ba100f880c7579765c5e63915a99bf1acc6967/go.mod) for their provenance.

The names oasdiff, OpenAPI, and other project names identify their respective projects. This repository is not an official oasdiff distribution or an endorsement by its maintainers.
