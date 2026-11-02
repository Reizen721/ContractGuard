# Changelog

All notable changes to ContractGuard are recorded here. The project follows semantic versioning for the rule engine and application packages.

## 2.0.0 - 2026-11-02

The consolidated release of the API change workbench and MCP plugin. Publication status and artifacts are listed on [GitHub Releases](https://github.com/Reizen721/ContractGuard/releases). The 1.x entries below describe the historical iterations in which each capability was developed.

- Refreshed the Web workspace with clearer navigation, typography, responsive layouts and evidence presentation, preserving contract analysis, AI explanations, caller migration, Agent reviews, history and exports.
- Consolidated the complete contract-to-caller workflow: pinned official oasdiff checks, native rules, bounded TypeScript evidence, explicit migration candidates and existing Node/Vitest tests on baseline/candidate/patched copies.
- Unified first-party package, native-engine, CLI, API and MCP/plugin version identifiers at 2.0.0; added a release-version consistency check. The integrated upstream oasdiff remains 1.35.0.
- Kept schemaVersion 1 and existing completed history readable without rewriting its original metadata. Added an explicit 1.5.0 regression-pack compatibility allowance, preserving original package checksums and rejecting unknown versions or modified input.
- Added nine cross-entry upgrade checks for real CLI replay, retained consumer gates, tamper/version rejection and historical HTTP list/detail/export behavior; included them in pnpm check.
- Replaced the Node project runner's JUnit file-attribute dependency with a bounded event reporter for Node.js 22 and 24. Preserved source-file selection, test identity, completion and cancellation checks; added 13 parser and real-runner regressions and a dual-version CI matrix.
- Reorganized the English and Chinese README around current usage, added a complete 2.0 guide and bilingual release notes, and documented portable MCP archive installation and DeepSeek input without putting credentials in plugin configuration.

See the [2.0 release notes](docs/releases/v2.0.0.en.md), [user guide](docs/v2.0-user-guide.md) and [verification index](docs/verification.md). Prior live-model acceptance remains labelled with its actual V1.8 version; the 2.0 release does not claim a new cloud run.

## 1.8.0 - 2026-11-02

Local iteration; not yet pushed or published. The native rule engine remains 1.5.0.

- Connected caller analysis and migration candidates to the built-in workflow and LLM planner. Caller records share the existing persistent history; evidence IDs remain explicit and the original compatibility gate is retained.
- Added operator-registered local projects, immutable input snapshots and fixture-file reuse. Web/MCP select a project ID; they cannot supply server paths or arbitrary test commands.
- Added existing Node test/Vitest execution on isolated baseline, candidate and patched copies, with fixed commands, bounded time/output, cancellation, test identity checks and explicit inconclusive outcomes. Trusted tests execute normal Node.js code; this is not an OS sandbox.
- Added project selection and migration-bundle import to the Agent UI, linked caller reports and three-stage test evidence. The MCP adapter now exposes 19 tools, including project discovery.
- Added a reproducible orders migration demo and a pinned public openapi-fetch benchmark using original client code and existing assertions with disclosed controlled response mutations.
- Added runner/API/MCP/UI/CLI tests, end-to-end regression, provenance, project onboarding documentation and verification records. Existing analysis, AI explanations, history and exports remain available.
- Clarified each available planner action after live DeepSeek review: OpenAPI validation, structural statistics, caller replay, project execution and final task synthesis have distinct scopes. Added a prompt regression and opt-in live acceptance with saved-run recovery, outside the default test suite.

## 1.7.0 - 2026-11-02

Local iteration; not yet pushed or published.

- Added `@contractguard/caller`: bounded TypeScript AST callsite discovery, source fingerprints, schema-checked baseline/candidate response replay, explicit output oracles, and per-file coverage limitations.
- Added explicit top-level field-rename proposals with exact source edits, unified diffs and re-verification of every supplied scenario in the affected file. Never edits the consumer workspace or clears the original deterministic gate.
- Added guarded `review-callers` CLI source collection and new-file-only report/patch export. Symlinks, traversal, source-tree writes and overwrites are rejected.
- Added persistent `/api/caller-reviews` with capped worker concurrency, cancellation, timeout and restart recovery; four MCP tools extend the existing 14 to 18.
- Added the web caller migration workspace, example input, source/field locations, observed outputs, patch inspection, history and exports.
- Preserved unsupported syntax, lexical shadowing/TDZ, unknown SDK calls, missing scenarios and unsupported request options as review/inconclusive outcomes; no submitted JavaScript, shell commands or live API requests are executed.
- Added seven labelled scenarios, caller/CLI/API/MCP/UI tests and a 15-check real core/HTTP/MCP regression suite. See the verification record for executed checks and environment limits.

## 1.6.0 - 2026-11-02

Local plugin/application delivery; not yet pushed or published. The native analysis engine and existing application packages remain 1.5.0: this iteration adds an access layer without changing rule semantics or pack compatibility.

- Added an MCP stdio adapter with 14 tools for analysis, saved explanations, bounded Agent reviews, history, cancellation and complete chunked report export.
- Reused the existing local HTTP service and persistence; Web and MCP see the same record IDs, model profiles and deterministic decisions.
- Added portable plugin packaging, Agent instructions, generated Codex/general MCP configuration and explicit Codex registration support. Generated bundles contain their runtime dependencies, not local histories or credentials.
- Added protocol tests, real-service integration checks and relocation tests alongside the existing regression suites. The plugin is local-only; host-specific installation and remote-only clients have explicit limits.

See the [plugin guide](docs/v1.6-agent-plugin.md) and [verification record](docs/verification.md).

## 1.5.0 - 2026-11-02

Local working source; not yet pushed or published.

- Integrated official oasdiff 1.35.0 at a pinned source commit, verified platform archives, full local CLI passthrough, and an offline bounded adapter for submitted contracts.
- Added saved Agent tasks, cancellation, restart recovery and evidence-linked migration reports through HTTP and CLI. Explicit workflow mode needs no model; opt-in LLM mode selects only allowed tools with budgets and mandatory checks.
- Redesigned the review workbench while preserving contract import, consumer checks, classic analysis history and AI report interpretation.
- Added source capability mapping, third-party licensing, delegation parity and real-engine Agent integration checks. Full CLI access is not a claim that every flag is exposed in the Web UI or that hosted upstream services were recreated.
- Bumped the native engine to 1.5.0. Regression packs intentionally require their creating engine version; retain the earlier installation to replay 1.4.0 packs.

See the [V1.5 guide](docs/v1.5-agent-workbench.md) and [verification record](docs/verification.md).

## 1.4.0 - 2026-11-02

Local working-source iteration; not yet pushed or published as a GitHub Release.

### Added

- Optional consumer evidence with named consumers, owners, criticality, decoded request examples and consumer-owned response assertions.
- Bounded, three-valued sample validation and separate `consumerImpact` results: passing examples, regressions, invalid baselines and inconclusive checks; operation-level change links, unmapped risks and deterministic migration tasks.
- Shared `analyzeRelease` orchestration across HTTP, CLI and Web without rewriting existing static findings, scores or compatibility flags.
- Independent `--fail-on-consumer` gates and explicitly created regression packs containing contracts, examples, policy, exact engine version and SHA-256 checksum; `verify-pack` replays them offline.
- Web evidence input, historical consumer reports, report export support, and synthetic cross-entry validation; see the [V1.4 guide](docs/v1.4-consumer-impact.md) and [engine comparison](docs/v1.4-engine-comparison.md).

### Changed

- New AI reviews use `ai-explainer-v4` with bounded consumer check metadata; original request/response samples, assertion schemas, owner names and issue messages are excluded. Earlier review versions remain readable.
- Analysis requests reject unsupported top-level fields to avoid silently ignoring misspelled evidence. The whole JSON body limit is now `2 * CONTRACTGUARD_MAX_SPEC_BYTES + 1 MiB + 64 KiB`; evidence has its own 1 MiB, 50-consumer and 200-interaction limits.

### Boundaries

- Samples are supplied by users; no live backend replay, automatic consumer discovery or complete JSON Schema conformance is claimed. Existing static severity gates remain independent.
- Saved reports retain check metadata and evidence fingerprints, not the submitted consumer bodies. Explicit regression packs contain original inputs and must be sanitized before sharing; their checksum is not a signature.
- Pack files are created exclusively, never overwritten by the pack writer, and require the exact creating engine version for replay. Older analyses without consumer impact remain readable as unevaluated, not passing.

## [1.3.0] - 2026-10-27

This entry describes local working-source changes. V1.3 has not yet been pushed or published as a GitHub Release.

### Added

- explicit local contract packages with an entry file and a bounded YAML/JSON text manifest; package-relative references retain recursive graph edges without network access;
- Web directory/multi-file import, entry selection, package preview, and a runnable multi-file Orders example;
- CLI opt-in dependency loading with `--bundle`, independent baseline/candidate roots, and filesystem boundary checks;
- per-file dependency fingerprints, manifest-order-independent package fingerprints, and original file/JSON Pointer finding locations;
- independent analysis `coverage` with bounded warnings for known unsupported or unproven areas, carried through Web/API/CLI and exported reports;
- `--fail-on-incomplete`, an explicit gate independent of severity thresholds, including when `--fail-on never` is selected;
- multi-file, dialect, source-mapping, path/budget, old-history, component, and cross-entry consistency regressions;
- a V1.3 local-package and upgrade guide documenting practical limits and non-goals.
- 20 hand-labelled, sequential acceptance scenarios across Core, HTTP and CLI, including rejection boundaries, report exports and history restoration after an isolated API restart.
- Eight composite business scenarios with shared models, precise finding locations, unchanged controls, dependency fingerprints, explicit partial coverage and reusable acceptance checks.

### Changed

- added a dialect-aware normalization layer for OpenAPI 3.0/3.1 nullable syntax and reference-adjacent semantics; safely supported constraints are combined rather than blindly overwritten;
- unknown dialect/resource semantics remain visible as coverage limitations instead of silently receiving a complete verdict;
- new AI explanations use `ai-explainer-v3` and receive bounded analysis-coverage metadata without original contract files; stored earlier review versions remain readable.

### Security and compatibility

- core and HTTP process only supplied text; only the explicitly enabled CLI adapter reads local package dependencies;
- packages reject remote URLs, root escapes, absolute/UNC/drive paths, duplicate or case-aliased files, and unsupported anchor/resource-scoped references; parsing, alias expansion, references, and dependency depth are bounded;
- older reports without `coverage` are shown as unrecorded scope, not inferred complete;
- `complete` means no known coverage warning in the implemented profile, not general Schema support, a formal compatibility proof, or production safety;
- default severity gates remain unchanged; users must explicitly enable incomplete-analysis gating.

## [1.2.0] - 2026-10-27

### Fixed

- compare OpenAPI 3.0 boolean exclusive numeric bounds and OpenAPI 3.1 numeric exclusive bounds as normalized intervals, including zero-valued endpoints;
- stop treating additional `oneOf` branches as automatically safe; report unproven composition changes conservatively and recognize equivalent reordering;
- detect parameter serialization and response-header contract changes;
- account for the previous additional-properties policy when classifying request-property additions and removals;
- bind Web results to the submitted input state and prevent stale asynchronous responses from overwriting a cleared or changed workspace;
- distinguish historical reports from editable inputs and preserve input/policy audit metadata;
- validate AI change references against only the bounded evidence actually sent to the model.

### Added

- locally persisted AI reviews with history retrieval, JSON/Markdown downloads, and explicit regeneration;
- per-analysis successful-result reuse keyed by relevant input, policy, engine, provider configuration, prompt, language, and focus; identical in-flight requests share an upstream call with subscriber-aware cancellation;
- server-owned AI evidence coverage metadata and advisory caveats, without changing deterministic scores or CI gates;
- atomic core/API/CLI consistency regressions, Vue component interaction tests, and AI persistence, evidence, cache, cancellation, and deletion-race tests;
- a V1.2 upgrade guide with local-data handling, migration, and acceptance instructions.

### Compatibility

- existing analysis history remains readable; previously unsaved AI reviews cannot be recovered;
- new reviews use prompt version `ai-explainer-v2`; older review metadata remains identifiable;
- improved detection can add findings and change scores and report-local change IDs; review upgraded CI results rather than silently weakening policies.

## [1.1.0] - 2026-09-23

### Added

- server-owned multi-LLM profiles for DeepSeek, OpenAI-compatible cloud endpoints, Gemini's compatibility endpoint, and local Ollama;
- a provider selector that exposes only enabled, sanitized profile metadata to the browser;
- strict JSON schemas and checked examples for LLM profiles and rule policies;
- policy-as-code controls for rule enablement, severity overrides, and scoring weights in the CLI and API;
- SHA-256 fingerprints for baseline input, candidate input, and the normalized applied policy;
- policy and input fingerprint metadata in JSON, Markdown, and HTML reports.

### Changed

- generalized the AI prompt, transport, response validation, UI, and documentation from a DeepSeek-only integration to an allowlisted OpenAI Chat adapter;
- added `providerId` to AI review requests and responses while preserving the legacy DeepSeek environment-variable path;
- made the Chat Completions output-token parameter profile-specific, including `max_completion_tokens` for newer OpenAI models;
- extended the Windows launcher with a PowerShell 5.1 implementation, strict preflight/stale-build validation, automatic local-profile discovery, install/build/no-AI modes, and a non-interactive `--check` mode;
- added CLI `--policy` and API `CONTRACTGUARD_POLICY_CONFIG` configuration;
- synchronized the Web, API, CLI, core engine, and workspace versions at `1.1.0`.

### Security

- kept all provider credentials in server-side environment variables; profile JSON stores only `secretEnv` names;
- restricted remote endpoints to HTTPS, rejected redirects and embedded credentials, and limited HTTP to explicitly declared local loopback profiles;
- prevented browser clients from supplying arbitrary model endpoints, headers, or credentials;
- kept automatic cross-provider fallback disabled to avoid unapproved data-boundary changes;
- propagated HTTP disconnect cancellation before the first asynchronous route operation, avoiding orphaned model calls;
- rejected circular or excessively deep object inputs during fingerprinting and preflighted CLI policy file size before reading.

## [1.0.1] - 2026-09-21

### Added

- bounded DeepSeek response streaming and recovery of a single schema-valid JSON review from brief surrounding prose;
- documentation-link and example-configuration checks in the main CI pipeline;
- stricter regression tests for AI output, OpenAPI parsing, local references, CLI escaping, and extension handling;
- responsive and keyboard-accessible Web interactions, including focus restoration and clearer retry states.

### Changed

- synchronized the Web, API, CLI, core engine, and workspace versions at `1.0.1`;
- limited generated AI lists to the documented UI bounds instead of failing an otherwise useful review;
- improved English and Chinese project documentation, security guidance, and reproducible verification records.

### Security

- capped DeepSeek response bodies at 128 KiB before parsing;
- tightened analysis ID, filename, and local JSON Pointer validation;
- used owner-only permissions for temporary analysis files where supported and guaranteed cleanup after writes.

## [1.0.0] - 2026-09-18

- Initial public release with a deterministic OpenAPI 3.0/3.1 compatibility engine, Web workspace, REST API, CLI/CI gate, local report history, exports, Docker support, and an optional DeepSeek explanation layer.

[1.0.1]: https://github.com/Reizen721/ContractGuard/compare/24466123b5dee1178e8dc3df26665a807027a16a...v1.0.1
[1.0.0]: https://github.com/Reizen721/ContractGuard/commit/24466123b5dee1178e8dc3df26665a807027a16a
[1.1.0]: https://github.com/Reizen721/ContractGuard/compare/v1.0.1...v1.1.0
[1.2.0]: https://github.com/Reizen721/ContractGuard/compare/v1.1.0...main
[1.3.0]: https://github.com/Reizen721/ContractGuard/compare/v1.1.0...main
