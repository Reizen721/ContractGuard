# ContractGuard Verifier-Guided Neuro-Symbolic CEGAR Architecture

## 1. Overview & Problem Formulation

Traditional OpenAPI diff tools (such as `oasdiff`) detect contract-level structural changes between a baseline specification $S_{\text{base}}$ and a candidate specification $S_{\text{cand}}$, while single-shot LLM coding agents frequently hallucinate field paths or produce patches that pass nominal happy-path unit tests yet crash at runtime on newly relaxed boundary states (such as `nullable: true`, newly optional properties, relaxed empty arrays, or extended enum variants).

ContractGuard formulates client-side API migration as a **Counterexample-Guided Abstraction Refinement (CEGAR)** synthesis loop over a multi-file TypeScript caller workspace $W$:

1. **Reachability-Grounded Diagnosis**: Using the TypeScript compiler's semantic `ts.TypeChecker` and fixed-point inter-procedural origin propagation, ContractGuard determines whether static breaking changes in $\Delta(S_{\text{base}}, S_{\text{cand}})$ actually intersect the caller's reachable AST expressions. Unreachable breaking changes are pruned without modifying caller code, while the original provider release gate (`releaseGate`) remains preserved for audit honesty.
2. **Differential Boundary Witness Synthesis**: Rather than testing only nominal happy-path fixtures, ContractGuard synthesizes schema-valid adversarial witnesses $w \in \mathcal{L}(S_{\text{cand}}) \setminus \mathcal{L}(S_{\text{base}})$ (`WIT-NULL`, `WIT-OPT`, `WIT-EMPTY`, `WIT-ENUM`).
3. **4-Gate Deterministic Sandbox Verification**: Every candidate patch $P_k$ in round $k \in \{1, \dots, K\}$ must simultaneously satisfy:
   - **Gate 1 (Compiler Semantic Gate)**: Zero `ts.TypeChecker` diagnostics across the virtual multi-file TypeScript program (`strict: true`).
   - **Gate 2 (Nominal Behavioral Gate)**: Execution of the existing `node --test` suite in an airgapped child process with identical test-identity hashes between baseline and candidate runs.
   - **Gate 3 (Outbound Request Contract Gate)**: Transport-layer `fetch` interception validating every outbound HTTP request URL, query parameter, header, and JSON body against $S_{\text{cand}}$.
   - **Gate 4 (Adversarial Witness Crash Gate)**: Property-based execution of exported caller entrypoints against every differential boundary witness $w \in \mathcal{L}(S_{\text{cand}}) \setminus \mathcal{L}(S_{\text{base}})$.
4. **Counterexample-Guided Refinement**: Whenever any gate rejects $P_k$, the verifier extracts a structured `VerificationCounterexample` (exact file, line, column, witness ID, and stack trace) and feeds it into Round $k+1$ (`symbolic`, `llm`, or `hybrid` mode) until all 4 gates pass or budget $K$ is exhausted. Unverified patches are never emitted as `finalPatches`.

---

## 2. Five-Layer Implementation Map

| Layer | Package & Source Module | Core Responsibility |
|---|---|---|
| **Layer 1: Alignment & Differential Witnesses** | [`packages/core/src/schema-align.ts`](../packages/core/src/schema-align.ts), [`packages/core/src/witness.ts`](../packages/core/src/witness.ts) | Infers 9 classes of request/response schema migration hypotheses (`inferSchemaMigrations`) without manual rename hints; synthesizes nominal + adversarial boundary payloads (`synthesizeDifferentialWitnesses`) and validates captured outbound HTTP requests (`validateOutboundRequest`). |
| **Layer 2: Inter-Procedural TypeChecker Slicer** | [`packages/caller/src/program-slice.ts`](../packages/caller/src/program-slice.ts) | Constructs an in-memory `ts.Program` (`createVirtualTsProgram`), propagates HTTP response origins across imported wrapper modules, destructuring bindings, and array callbacks (`analyzeProgramDataflow`), prunes unreachable static breaking changes, and extracts minimal AST `ProgramSlice` contexts. |
| **Layer 3: Airgapped 4-Gate Verifier Sandbox** | [`packages/project/src/http-interceptor.ts`](../packages/project/src/http-interceptor.ts), [`packages/project/src/cegar-sandbox.ts`](../packages/project/src/cegar-sandbox.ts) | Preloads a transport-layer HTTP interceptor (`--import`) blocking real sockets (`net`/`tls`/`http`/`https`), serves deterministic route fixtures, logs outbound requests to NDJSON, and executes the 4 verification gates (`verifyCegarWorkspace`). |
| **Layer 4: Multi-Round CEGAR Engine, API & CLI** | [`apps/api/src/cegar/engine.ts`](../apps/api/src/cegar/engine.ts), [`apps/api/src/cegar/synthesizer.ts`](../apps/api/src/cegar/synthesizer.ts), [`apps/api/src/cegar/llm-proposer.ts`](../apps/api/src/cegar/llm-proposer.ts), [`apps/cli/src/cegar-command.ts`](../apps/cli/src/cegar-command.ts) | Orchestrates Round $0 \dots K$ refinement across `symbolic`, `llm`, and `hybrid` proposers; exposes `/api/cegar/*` REST endpoints and `contractguard cegar` CLI command. |
| **Layer 5: Interactive CEGAR Workbench & Benchmark** | [`apps/web/src/components/CegarWorkspace.vue`](../apps/web/src/components/CegarWorkspace.vue), [`benchmarks/contractbench/dataset.mjs`](../benchmarks/contractbench/dataset.mjs), [`scripts/run-contractbench.mjs`](../scripts/run-contractbench.mjs) | Visualizes schema hypotheses, slice compression, 4-gate round trajectories, counterexamples, and verified unified diffs; evaluates 24 API evolution cases across 4 ablated systems (`ContractBench`). |

---

## 3. CLI & REST Quick Reference

### CLI Execution
```bash
# Run built-in 2-round nested + nullable showcase preset
node apps/cli/dist/index.js cegar --preset preset-nested-nullable

# Run full 24-case ContractBench 4-system ablation study
pnpm benchmark:cegar
```

### REST Endpoints
- `GET /api/cegar/status` — Verifier gate inventory and LLM profile readiness.
- `GET /api/cegar/presets` — Built-in multi-round and reachability-control presets.
- `POST /api/cegar/runs` — Execute a bounded CEGAR migration run and persist its audit record.
- `GET /api/cegar/runs/:id` — Retrieve full round-by-round trajectory, counterexamples, and unified diffs.
- `GET /api/cegar/runs/:id/report?format=markdown|json` — Export auditable CEGAR migration report.

### MCP Stdio Tools (`@contractguard/mcp`)
- `contractguard_run_cegar` — Execute a multi-round 4-gate CEGAR self-repair run via `presetId` or explicit `baseline`, `candidate`, `callerFiles`, and `testFiles`.
- `contractguard_get_cegar_run` — Read overview or paginated `hypotheses`, `witnesses`, `rounds`, `patches` (Unified Diffs), and `reachability`.
- `contractguard_list_cegar_runs` — List saved CEGAR runs (and built-in presets with `includePresets: true`).
- `contractguard_export_cegar_run` — Export complete Markdown or JSON CEGAR audit report in lossless chunks.

See [`benchmarks/contractbench/REPORT.md`](../benchmarks/contractbench/REPORT.md) for the latest empirical benchmark results.
