---
name: ContractGuard release review
description: High-craft developer workbench for contract evidence, caller replay and release decisions
colors:
  primary: "#1e4e79"
  background: "#f6f8fa"
  surface: "#ffffff"
  surface-muted: "#f0f3f7"
  text: "#0f172a"
  text-muted: "#5b6778"
  separator: "#e1e6ef"
  separator-strong: "#c5cedb"
  failure: "#b91c1c"
  review: "#9a5b0a"
  pass: "#157347"
typography:
  headline:
    fontFamily: "Segoe UI, -apple-system, BlinkMacSystemFont, Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "25px"
    lineHeight: 1.28
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Segoe UI, -apple-system, BlinkMacSystemFont, Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "14px"
    lineHeight: 1.55
  code:
    fontFamily: "Cascadia Code, Cascadia Mono, JetBrains Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "12.5px"
    lineHeight: 1.65
rounded:
  control: "4px"
  panel: "6px"
spacing:
  compact: "8px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "6px 13px"
---

# ContractGuard interface

## Overview
Release review workbench: an engineering review reads as a high-precision developer workbench inspired by Stripe Workbench, Vercel Geist, Linear, and Scalar OpenAPI tools. The interface uses a persistent 58px top command bar, dual-pane contract diff editors, a tabular-numeral verdict ledger, and split-pane inspection layouts for Agent workflows, caller AST replay, and 3-phase existing project test execution.

## Colors
| Token | Value | Purpose |
| --- | --- | --- |
| Background | `#f6f8fa` | Cool-neutral architectural slate canvas |
| Surface | `#ffffff` | Elevated editable inputs, inspector panels and report evidence |
| Muted surface | `#f0f3f7` | Table headers, editor bars and code chrome |
| Text | `#0f172a` | Primary copy and architectural headings |
| Muted text | `#5b6778` | Metadata, provenance and supporting text |
| Separator | `#e1e6ef` | 1px structural hairlines for rows and section boundaries |
| Strong separator | `#c5cedb` | Interactive input boundaries and primary panel frames |
| Accent | `#1e4e79` | Active navigation, primary action, focus ring |
| Failure | `#b91c1c` | Deterministic blocking findings and regressions |
| Review | `#9a5b0a` | Uncertainty, partial coverage and manual review items |
| Pass | `#157347` | Explicit validated outcomes within stated scope |

## Typography
Chinese UI uses Segoe UI, Microsoft YaHei UI, PingFang SC and Noto Sans CJK SC fallbacks. Code, SHA-256 fingerprints, rule IDs and tabular metrics use Cascadia Code / Cascadia Mono / JetBrains Mono / Consolas (`font-variant-numeric: tabular-nums`). Fonts are local; no remote font request is made.

## Layout
- Top command bar (`58px` sticky) connects contract editing, Agent tasks, caller migration, saved reports and the rule catalog, with live service telemetry on the right.
- Comparison: baseline and candidate sit side-by-side on desktop (`minmax(0,1fr) 32px minmax(0,1fr)`), stacked below 600px. Single and multi-file modes share the same editor frame.
- Agent: `320px` left task configuration and run history column paired with a structured inspection document on the right. Submission captures an immutable input snapshot.
- Caller migration: `260px` left history column paired with callsite locations, baseline vs. candidate replay outcomes, and unified diff patch verification on the right.
- Execution mode is explicit. Fixed workflow is the default and does not call a model. LLM orchestration is unavailable when the service cannot run it; selecting it reveals the data-sharing explanation and configured model choice.
- Keep execution status, deterministic verdict and generated recommendations separate. Evidence IDs remain visible. Missing, interrupted or failed checks cannot be styled as a pass.
