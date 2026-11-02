# ContractGuard

<!-- impeccable:product-schema 1 -->

## Platform
Web application running alongside a local API service.

## Product truth
The user requests an OpenAPI compatibility tool that can grow into an autonomous Agent. The approved first phase analyzes submitted contracts and consumer evidence, executes checks, and produces migration recommendations. It does not edit application code or publish changes.

## Users and task
Inferred from the existing implementation: API developers and reviewers preparing a release, comparing a baseline and candidate, and investigating whether a consumer will regress. The interface is Chinese; contract syntax and identifiers remain verbatim.

## Mechanism
Deterministic contract checks, a pinned upstream oasdiff engine, and finite consumer examples supply independently inspectable evidence. Optional model planning selects approved checks and proposes evidence-linked migration advice. Deterministic verdicts remain separate from generated prose.

## Constraints
Preserve single-file and local multi-file inputs, saved analysis reports, saved AI explanations, consumer evidence, exports, coverage limitations, and cancellation/stale-input handling. Explicitly distinguish local fixed workflow from optional cloud LLM planning. Never imply finite examples prove universal compatibility.

## Success
Reviewers can identify what ran, which evidence supports a finding, what remains unchecked, and what to verify next. The user explicitly requests an interface that feels less templated.

## Stack
Existing Vue 3, TypeScript and Vite application; native accessible controls. No additional UI framework is required.

## Open decisions
The exact audience segment and production deployment model are inferred rather than user-confirmed. No market superiority or comprehensive rule parity claim belongs in product copy without measured evidence.
