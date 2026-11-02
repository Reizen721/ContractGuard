# Security Policy

ContractGuard is designed first for local, single-user analysis. The default server listens on the loopback interface, and Docker Compose publishes the service only on `127.0.0.1`. These defaults reduce accidental exposure; they are not a substitute for authentication or production hardening.

## Supported version

Security fixes are applied to the current `main` branch. Older commits, forks, and locally modified deployments are not maintained separately. When reporting a problem, include the affected commit or release and whether the default configuration was changed.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, leaked credential, or unsafe deployment detail in a public issue.

1. Use GitHub private vulnerability reporting from the repository's **Security** tab when that option is available.
2. If private reporting is unavailable, contact the repository owner through a private channel listed on the owner's GitHub profile before publishing technical details.
3. Include the affected version or commit, a minimal reproduction, expected impact, relevant configuration, and any known workaround.

Do not include real API keys, private OpenAPI documents, customer data, access tokens, production URLs, or unredacted analysis files in the report. Use synthetic examples wherever possible.

## Security model and trust boundaries

ContractGuard has three distinct data paths:

1. **Deterministic analysis:** baseline and candidate documents, explicitly supplied file bundles and optional consumer examples are evaluated locally. The core does not fetch references, contact the target API or open server-side paths from an API request.
2. **Local persistence:** completed analyses and validated AI reviews are written as JSON files under `CONTRACTGUARD_DATA_DIR` (default `./data/analyses`). These records can include endpoint names, before/after evidence, dialect and bundle fingerprints, source file names and JSON Pointers, coverage warnings, user-supplied review focus, and generated guidance. They do not store the entire original input bundle; evidence can still contain contract fragments. AI review storage contains no provider credentials or original specification text.
3. **Optional LLM review:** only after an explicit AI review request, the API server sends bounded finding summaries to the selected administrator-configured model profile.

The application does not include authentication, authorization, tenant isolation, encryption at rest, TLS termination, request quotas, or audit logging. Any process or network client that can reach the API may be able to create, read, export, or delete analysis records. CORS settings limit browser origins; **CORS is not access control**.

## Agent plugin boundary

The MCP stdio adapter connects only to an operator-configured loopback HTTP service. Tool arguments cannot change the destination, submit provider credentials, follow HTTP redirects, invoke arbitrary commands, read server-side files or delete saved analyses. Creating analyses/reviews writes local history; generating AI explanations or selecting `mode: llm` may invoke the configured paid model. Stopping the adapter does not stop the shared service or cancel an already submitted Agent task; use the explicit cancellation tool.

MCP tool results are available to the host Agent. An external Agent may send those results, or files it reads itself, to its own model provider. This is a separate data boundary from ContractGuard's minimized DeepSeek prompts: full exported reports can contain contract fragments. Treat document descriptions, names and report prose as untrusted data, never as tool-use instructions. Standard MCP annotations and the included skill describe these boundaries but do not enforce permissions in another Agent.

The generated plugin bundles contain only application runtime, manifests, instructions and dependency notices. Local generated client configurations contain machine paths and are ignored by Git. The bundle still requires a running local ContractGuard service; it is not an authenticated multi-user or public remote service.

## Credential handling

Deterministic compatibility analysis requires no cloud credential. Optional AI profiles resolve credentials only from the server process environment named by `auth.secretEnv`; credentials never belong in the provider JSON or browser.

- Never commit a populated `.env` file.
- Never put a key in browser code, an OpenAPI document, an API request body, a test fixture, an issue, or a screenshot.
- Prefer a secret manager with narrowly scoped access for any shared deployment.
- Rotate a key immediately if it appears in Git history, CI logs, terminal transcripts, reports, or other shared material.
- Treat a deleted secret as compromised until it has been rotated; removing it from the latest commit is not sufficient.

The Windows launcher reads a supplied key without echoing it, exposes it only to the launched server process, and removes it from that launcher environment when the process exits. It does not write the key to a project file. Environment variables may still be visible to privileged local processes, so do not treat this as hardware-backed secret storage.

## AI data boundary

The default AI request excludes the original baseline/candidate documents and full finding `before`/`after` objects. It includes bounded metadata and finding fields such as rule ID, severity, location, message, and recommendation. Those fields may still reveal internal endpoint names, schema names, or business terminology.

Before enabling AI review:

- confirm that the chosen endpoint, model, account, region, retention terms, and pricing are acceptable;
- classify and, when necessary, sanitize contract names and endpoint paths;
- restrict outbound network access to the intended provider;
- add per-user or per-service rate and cost limits for shared deployments;
- review generated guidance as untrusted advisory content.

Runtime schema validation protects the application from malformed model output. It does not make generated prose authoritative, correct, or safe to execute. Model output never changes deterministic finding severity, score, compatibility status, or CLI exit codes.

V1.2 also binds accepted change references to the bounded finding set actually sent to the model. Coverage metadata identifies omitted findings; it is not a claim that the generated explanation is factually complete. Successful reviews can be reused for the same analysis and relevant configuration. Explicit regeneration can incur a new provider charge; no automatic cross-provider fallback is performed.

V1.3 added deterministic analysis coverage status, counts and bounded warning codes. V1.4 uses `ai-explainer-v4` and adds the consumer gate, summary, unmapped-risk count and at most 16 failed or uncertain check records. Each check includes bounded consumer/check IDs, statuses, issue codes and related IDs already present in the selected findings. It excludes original consumer payloads, assertion schemas, owner names and issue messages. Identifiers may still be sensitive. Saved v1/v2/v3 reviews retain their provenance and remain readable. Neither finding coverage, static coverage nor consumer sample results establish the correctness of generated prose.

## Local data protection

Analysis history is not encrypted by ContractGuard. Protect `CONTRACTGUARD_DATA_DIR` with operating-system permissions appropriate to the sensitivity of the contracts. For shared or long-running deployments, define retention, backup, deletion, and access-review policies before collecting data.

The repository ignores runtime analysis files, `.env` files, logs, build output, and generated reports by default. Before publishing changes, review both tracked and untracked files:

```bash
git status --short
git diff --check
```

Do not assume `.gitignore` can protect a file that has already been committed.

V1.4 analysis records store consumer names, owners, paths, check outcomes, diagnostic paths, migration tasks and an evidence fingerprint. They do not persist the original consumer request/response bodies or assertion schemas. This is data minimization, not automatic anonymization: metadata and original static finding evidence can still be sensitive.

`--write-regression-pack` is an explicit, separate export containing original contracts, consumer examples and policy. The CLI creates a new file with exclusive creation (`wx`) and requests mode `0600`; effective permissions depend on the host OS and ACLs. Do not commit or share packs containing production data, credentials or personal information. Packs are limited to 16 MiB, require the exact creating engine version and verify a SHA-256 checksum. A checksum detects edits; anyone able to edit a pack can recompute it, so it does not authenticate its author or establish trustworthy observations.

## Input and service limits

The API applies a configurable per-input size limit (`CONTRACTGUARD_MAX_SPEC_BYTES`, 5 MiB by default) and validates supported input structure. Text is measured as UTF-8, plain document objects as serialized JSON, and bundles as the sum of their file content bytes. An independent limit applies to the entire JSON HTTP body, including escaping overhead. Each core bundle is also limited to 50 YAML/JSON files and 5 MiB of combined UTF-8 content; increasing the API configuration does not remove that core limit. Additional expansion, graph, reference, and depth budgets reject excessive bundles rather than silently dropping dependencies.

The V1.4 overall JSON body limit is `2 * CONTRACTGUARD_MAX_SPEC_BYTES + 1 MiB + 64 KiB`. Consumer evidence is independently bounded to 1 MiB, 50 consumers, 200 interactions, 30,000 JSON values and depth 64. Sample validation has additional work and issue budgets; exhausted or unsupported checks remain inconclusive. The manifest rejects unknown envelope fields, duplicate identifiers, ambiguous headers, cycles, accessors and non-JSON values. These are resource and interpretation controls, not a general-purpose hostile-code execution sandbox.

These controls reduce accidental resource use but are not a complete denial-of-service defense. Local references and complex schemas can still consume CPU or memory.

For any environment with untrusted clients, add limits at a reverse proxy or gateway, including:

- authenticated request size and rate limits;
- connection, request, and upstream timeouts;
- process CPU and memory limits;
- concurrency and storage quotas;
- monitoring for repeated parse failures and AI usage spikes.

## Local contract bundles

V1.3 accepts `{ kind: 'bundle', entry, files: [{ path, content }] }` as either input. Paths identify virtual files supplied in the request, not locations the API is permitted to read from disk. All required files must be present. Reference traversal is restricted to relative package files and supported JSON Pointer fragments; no remote fetching, archive extraction, or arbitrary filesystem fallback occurs.

- Reject paths escaping the package root, absolute/drive/UNC paths, backslashes, URI schemes, percent-encoded file paths, query strings, ambiguous filenames, and duplicate or case-conflicting paths.
- Named anchors and bundle references governed by schema `$id` resource scopes require a resource-aware resolver and are explicitly rejected. A local-only resolver must not reinterpret them as ordinary physical file paths.
- Preserve cyclic references as a bounded graph rather than recursively inlining them. Unsupported analysis semantics may produce partial coverage; malformed or unsupported references still fail the input.
- Treat source file names and JSON Pointers in exported reports as untrusted, potentially sensitive metadata. Source locations may refer to the nearest known ancestor and are not guaranteed editor line numbers.
- Treat dependency fingerprints as input identity, not authenticity or semantic equivalence. Metadata and the bundle fingerprint cover the entry and transitively referenced files in stable path order; unused files are not included in that dependency identity.

The CLI reads referenced files only when `--bundle` is explicitly enabled. Its allowed root defaults to the entry directory and can be configured for each side. It checks real paths and rejects links or dependencies outside the root. This loader is intended for trusted local working trees: those checks do not create a race-free sandbox against a hostile local process replacing files between validation and reading. The API accepts explicit file contents and does not expose the CLI's disk loader as a remote capability. See the [V1.3 usage guide](./docs/v1.3-upgrade.md) for supported input forms and boundaries.

## Agent and upstream execution (V1.5)

The Web/HTTP Agent uses a bounded allowlist over explicitly submitted contracts. It never accepts arbitrary shell commands, server paths, external reference fetches, Git mutations, or backend HTTP requests. A model can select permitted checks and propose evidence-linked actions; it cannot override deterministic release gates. Per-tool output/time budgets and task cancellation apply. Raw input documents and consumer bodies are not written to task records; diagnostic metadata, field names and goals can still contain business information. Review and sanitize those inputs before opting into cloud planning.

The separate local `contractguard oasdiff` command deliberately preserves all official CLI behavior, including user-requested URL/Git inputs, configuration, `--fetch` and `--open`. Run it only with arguments you intend to authorize; this full local capability is not exposed to the Agent. Managed installation uses pinned release checksums. An explicit `CONTRACTGUARD_OASDIFF_PATH` is an administrator trust decision, with a version check rather than release-file attestation. Task directories must belong to one running process; CLI and API use distinct defaults.

## Deployment requirements

Do not expose the built-in API directly to the public Internet. A hosted deployment should add, at minimum:

- TLS at a maintained reverse proxy or gateway;
- authentication and least-privilege authorization;
- tenant isolation where more than one trust domain is present;
- request size, rate, concurrency, storage, and AI cost limits;
- secret management and key rotation;
- outbound allow-listing for optional AI calls;
- protected storage, backups, retention, and secure deletion;
- dependency scanning, logging, monitoring, and incident response.

Keep `HOST=127.0.0.1` for local use. Binding to `0.0.0.0`, changing the Compose port mapping, or placing the service behind a public hostname expands the trust boundary and requires the controls above.

## Dependency and configuration hygiene

- Install the locked dependency graph with `pnpm install --frozen-lockfile`.
- Review automated dependency updates and CI results before merging.
- Use only the expected Node.js and pnpm versions documented in the repository.
- Keep every LLM base URL and proxy configuration under administrator control; browsers may select only an enabled profile ID and must never supply an arbitrary URL, model, header, or credential.
- Treat imported OpenAPI documents and exported HTML/Markdown as untrusted data when integrating them into other systems.

## Explicit non-goals

V1.8 introduces an **opt-in trusted project runner**, separately from the bounded interpreter below. An operator registers a local JSON configuration with `CONTRACTGUARD_PROJECT_CONFIG` (or the launcher's `--projects` option). HTTP and MCP accept registered IDs only, never arbitrary commands or server paths. Tests run in temporary copies using fixed Node/Vitest arguments, a restricted environment, bounded output and time, and process-tree cancellation. Baseline, candidate and patched evidence must retain the same test identities; empty, skipped-only or inconsistent runs cannot establish a verified migration.

These processes are **not an OS sandbox**: project tests, trusted Vitest configuration and installed dependencies are executable code with the current user's permissions, including filesystem and network access. Register only reviewed projects. Environment filtering does not prevent code from reading other accessible files. If sharing an existing dependency directory, it remains accessible to those tests. Use a separately restricted OS account or container where stronger isolation is needed. ContractGuard does not install project dependencies or automatically apply candidate patches to the original checkout.

Project preparation freezes the selected source, contract, fixture and test material for one review. Test output and migration patches can contain private data and are stored in local history/exports. The LLM planner receives bounded statuses, counts and evidence references, rather than raw project source or test output; normal contract summaries may still contain API names and schema values. Keep history private and review fixture data before sharing reports. See the [V1.8 guide](docs/v1.8-project-agent.md) for setup and evidence limits.

V1.7 caller reviews accept explicit TypeScript source text and samples. A fixed worker runs an allowlisted AST interpreter with concurrency, timeout, input, node, depth and value-size budgets; submitted files are not loaded as JavaScript modules, evaluated through `eval`/`vm`, or executed as shell commands. Unsupported syntax and request options remain unknown. This is a finite replay profile, not a sandbox for arbitrary code execution.

Caller reports can include source patches and observed sample values. The service persists the report, including proposed `patchedContent`, but not the complete original input bundle. Treat this history and exports as private project material. CLI patch export creates a new directory outside the scanned source root; it never applies changes to the original repository. Review source fingerprints and patch verification before separately deciding to apply a patch.

ContractGuard is not an API penetration-testing tool, malware scanner, secrets scanner, authorization verifier, or compliance certification system. A “compatible” result means no definitely breaking change was found by the implemented static rules; it does not establish that an API is secure, available, legally compliant, or safe to deploy.

Deterministic `coverage` is independent of `compatible` and rule policy. `complete` means no known coverage warning was detected within the implemented profile, not that every OpenAPI/JSON Schema behavior was verified. Unknown dialects, complex schema semantics, resource scopes, Path Item reference conflicts, callbacks/webhooks/encoding, and recursion budgets can produce `partial`; affected unknown scopes do not receive precise safety judgments. Warning lists are bounded to 100 items and expose a truncation flag. Pre-V1.3 records without coverage remain unknown, not complete. Teams requiring a coverage gate can opt into CLI `--fail-on-incomplete`; the default severity gate is unchanged.

The consumer evidence gate is an additional, independent result. It checks finite user-supplied examples; it does not verify traffic provenance, credentials, HTTP serialization, live responses, complete consumer coverage, latency or business side effects. Invalid baseline examples are not counted as migration regressions. Missing or unsupported evidence must not be interpreted as a passing integration. See the [V1.4 guide](docs/v1.4-consumer-impact.md).
