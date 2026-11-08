# ContractBench v1.0 — Quantitative Evaluation & Ablation Report

- **Generated At**: `2026-11-08T08:08:58.809Z`
- **Total Benchmark Cases**: **24** (22 active caller regressions + 2 unreachable-breaking control cases)
- **Synthesized Differential Adversarial Witnesses**: **10** boundary payloads (`WIT-NULL`, `WIT-OPT`, `WIT-EMPTY`, `WIT-ENUM`)
- **Mean AST Program Slice Token Reduction**: **43.5%**
- **Total Evaluation Wall-Clock Time**: **122.5s**

## 1. System-Level Quantitative Comparison (4-System Ablation)

| System Variant | Verified Patch@1 (22 Regressions) | Verified Patch@4 (22 Regressions) | Unreachable Breaking Pruning (2 Controls) | Unsafe Pass Rate (Silent Runtime Crash) |
|---|---|---|---|---|
| Static Diff Only (oasdiff / Core) | 0/22 (0.0%) | 0/22 (0.0%) | 0/2 (0.0%) | 0.0% *(no patches)* |
| Legacy 1-Shot Flat Rename | 0/22 (0.0%) | 0/22 (0.0%) | 0/2 (0.0%) | 0.0% |
| Ablation: CEGAR w/o Gate 4 Adversarial Witnesses | 14/22 (63.6%) | 14/22 (63.6%) | 2/2 (100.0%) | **8/22 (36.4%)** |
| **ContractGuard CEGAR (Full 4-Gate + Multi-Round)** | **14/22 (63.6%)** | **22/22 (100.0%)** | **2/2 (100.0%)** | **0/24 (0.0%)** |

## 2. Per-Category Breakdown

| Category | Cases | Legacy Flat | Ablation (w/o Gate 4 Witnesses) | CEGAR @ Round 1 | CEGAR @ Round K (Full) |
|---|---|---|---|---|---|
| `RENAME` | 4 | 2/4 | 4/4 *(unsafe: 0)* | 4/4 | **4/4 (100.0%)** |
| `STRUCTURAL` | 4 | 0/4 | 4/4 *(unsafe: 0)* | 4/4 | **4/4 (100.0%)** |
| `TYPE_SHIFT` | 4 | 0/4 | 4/4 *(unsafe: 0)* | 4/4 | **4/4 (100.0%)** |
| `NULLABILITY` | 4 | 0/4 | 0/4 *(unsafe: 4)* | 0/4 | **4/4 (100.0%)** |
| `ENUM_EXT` | 4 | 0/4 | 0/4 *(unsafe: 4)* | 0/4 | **4/4 (100.0%)** |
| `REQUEST_TIGHTEN` | 4 | 0/4 | 4/4 *(unsafe: 0)* | 4/4 | **4/4 (100.0%)** |

## 3. Case-by-Case Verification Matrix

| ID | Category | Evolution Scenario | Legacy | Ablation (No Gate 4) | CEGAR Full | Rounds | Slice Reduction |
|---|---|---|---|---|---|---|---|
| `CB-01` | `RENAME` | Direct property rename with TypeScript DTO interface | FAIL | PASS | **VERIFIED** | 1 | 38.8% |
| `CB-02` | `RENAME` | Object destructuring binding rename | FAIL | PASS | **VERIFIED** | 1 | 42% |
| `CB-03` | `RENAME` | Control #1: Unreachable removed response fields (single-file) | PASS | PASS | **VERIFIED** | 0 | 40.3% |
| `CB-04` | `RENAME` | Control #2: Unreachable removed field across 2-file wrapper | PASS | PASS | **VERIFIED** | 0 | 51.7% |
| `CB-05` | `STRUCTURAL` | Property nesting (postalCode -> location.postalCode) | FAIL | PASS | **VERIFIED** | 1 | 39.9% |
| `CB-06` | `STRUCTURAL` | Property flattening (author.handle -> authorHandle) | FAIL | PASS | **VERIFIED** | 1 | 39.4% |
| `CB-07` | `STRUCTURAL` | Pagination envelope wrap (Order[] -> { items: Order[], total }) | FAIL | PASS | **VERIFIED** | 1 | 39.9% |
| `CB-08` | `STRUCTURAL` | 3-file inter-procedural wrapper chain (userName -> profile.displayName) | FAIL | PASS | **VERIFIED** | 1 | 58.5% |
| `CB-09` | `TYPE_SHIFT` | Monetary integer cents -> decimal string (amountCents -> amountDecimal) | FAIL | PASS | **VERIFIED** | 1 | 41.1% |
| `CB-10` | `TYPE_SHIFT` | Unix epoch seconds -> ISO-8601 date-time string | FAIL | PASS | **VERIFIED** | 1 | 42% |
| `CB-11` | `TYPE_SHIFT` | Numeric latency -> string numeric representation in arithmetic expression | FAIL | PASS | **VERIFIED** | 1 | 39% |
| `CB-12` | `TYPE_SHIFT` | Boolean flag -> lifecycle enum (isArchived: boolean -> archiveState: ACTIVE|ARCHIVED) | FAIL | PASS | **VERIFIED** | 1 | 41.1% |
| `CB-13` | `NULLABILITY` | Structural nest + nullable container (reviewerName -> reviewer?.name | null) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 42.4% |
| `CB-14` | `NULLABILITY` | Required string -> optional omitted property (couponCode WIT-OPT) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 40.3% |
| `CB-15` | `NULLABILITY` | Field rename + newly nullable number calling .toFixed(2) (WIT-NULL) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 40.7% |
| `CB-16` | `NULLABILITY` | Array minItems relaxation (minItems: 1 -> 0) indexing head element [0] (WIT-EMPTY) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 40.3% |
| `CB-17` | `ENUM_EXT` | Enum rename + new variant crashing exhaustive switch default throw (WIT-ENUM) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 54.1% |
| `CB-18` | `ENUM_EXT` | New payment rail enum variant crashing dictionary lookup .toFixed(2) (WIT-ENUM) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 36.3% |
| `CB-19` | `ENUM_EXT` | Numeric return-type switch with renamed + extended priority enum (TypeChecker fallback 0) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 50.6% |
| `CB-20` | `ENUM_EXT` | 2-file client wrapper + extended review verdict enum (WIT-ENUM) | FAIL | UNSAFE PASS | **VERIFIED** | 2 | 60.1% |
| `CB-21` | `REQUEST_TIGHTEN` | Newly required query parameter (apiVersion=2026-11) | FAIL | PASS | **VERIFIED** | 1 | 37.6% |
| `CB-22` | `REQUEST_TIGHTEN` | Query parameter rename + maximum bound clamping (limit=50 -> pageSize=20) | FAIL | PASS | **VERIFIED** | 1 | 37.1% |
| `CB-23` | `REQUEST_TIGHTEN` | Newly required HTTP request header (x-tenant-region) | FAIL | PASS | **VERIFIED** | 1 | 39.4% |
| `CB-24` | `REQUEST_TIGHTEN` | POST JSON request body property rename + response property rename | FAIL | PASS | **VERIFIED** | 1 | 50.9% |

## 4. Reproducibility

- Dataset definition: [dataset.mjs](./dataset.mjs)
- Machine-readable artifact: [results.json](./results.json)
- Run command: `pnpm benchmark:cegar`
