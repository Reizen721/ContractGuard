---
name: ContractGuard release review
description: Compact workbench for contract evidence and release decisions
colors:
  primary: "#305e50"
  background: "#f5f5f1"
  surface: "#ffffff"
  surface-muted: "#f1f2ee"
  text: "#242b2a"
  text-muted: "#626d66"
  separator: "#d9ddd5"
  separator-strong: "#b9c1b7"
  failure: "#a32e32"
  review: "#865e12"
  pass: "#28704f"
typography:
  headline:
    fontFamily: "Segoe UI, Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "27px"
    lineHeight: 1.3
    letterSpacing: "-0.6px"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  code:
    fontFamily: "Cascadia Code, Cascadia Mono, Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.75
rounded:
  control: "3px"
  panel: "0px"
spacing:
  compact: "8px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
---

# ContractGuard interface

## Overview
Release review workbench: an engineering review should read as an ordered working document. The user requested a less templated interface and an Agent that performs checks and proposes migrations. The redesign replaces the persistent side rail, oversized page heading, circular score and metric card grid with horizontal navigation, compact input panes, a verdict ledger and inspectable execution rows.

Product facts are in PRODUCT.md. The audience description is inferred from the repository and the user's approved task. This implementation followed the parent's explicit workbench brief without adding a design approval round. The required concept-seed probe ran (`seed:52a38c1186e4fa50`); the supplied design brief took precedence over unrelated challenger imagery.

## Colors
| Token | Value | Purpose |
| --- | --- | --- |
| Background | `#f5f5f1` | Quiet warm document ground |
| Surface | `#ffffff` | Editable inputs and report evidence |
| Muted surface | `#f1f2ee` | Table and contract headings |
| Text | `#242b2a` | Main copy and headings |
| Muted text | `#626d66` | Metadata and supporting text |
| Separator | `#d9ddd5` | Rows and section boundaries |
| Strong separator | `#b9c1b7` | Inputs and major divisions |
| Accent | `#305e50` | Active navigation, primary action, focus |
| Failure | `#a32e32` | Deterministic blocking findings |
| Review | `#865e12` | Uncertainty and incomplete coverage |
| Pass | `#28704f` | Explicit validated outcomes |

## Typography
Chinese UI uses Segoe UI, Microsoft YaHei UI, PingFang SC and Noto Sans CJK SC fallbacks. Code and identifiers use Cascadia Code / Cascadia Mono / Consolas. Fonts are local; no remote font request. Page titles are 27px, section titles 17–21px, normal UI copy 12–14px.

## Layout
- Top navigation connects contract editing, Agent tasks, saved reports and the rule catalog. Preserve visible keyboard focus and native buttons.
- Comparison: baseline and candidate are adjacent on desktop, stacked below 600px. Single and multi-file modes share the same surface.
- Agent: 292px task column and remaining evidence column on wide screens; stacked below 600px. Submission uses the current editor snapshot. Saved runs never borrow later editor content.
- Execution mode is explicit. Fixed workflow is the default and does not call a model. LLM orchestration is unavailable when the service cannot run it; selecting it reveals the data-sharing explanation and configured model choice.
- Keep execution status, deterministic verdict and generated recommendations separate. Evidence IDs remain visible. Missing, interrupted or failed checks cannot be styled as a pass.
- Poll only active records, abort superseded reads, stop on unmount, bound automatic polling, and offer manual resumption after a connection failure.
- Restore the last selected task by its ID; source inputs and keys never go into browser storage.
- History is a compact table. Long reports flow vertically, with details for provenance and evidence indices. Small screens scroll the history table within its container.

## Elevation & Depth
The working surfaces are flat, divided by thin rules. The existing shadow token `0 12px 32px rgb(16 24 40 / 10%)` is retained only for transient overlays such as notifications and menus.

## Shapes
Controls use 3px or square corners. Contract panels, evidence rows and report sections use square boundaries.

## Components
Consumer samples and finite-sample scope, saved AI interpretations, multi-file entry selection, source fingerprints, current-input/stale-report separation, report exports, and rule catalog keyboard behavior remain available. The Agent web flow exposes approved checks; the complete upstream command surface remains a local CLI feature, not a claim about every web control.

## Do's and Don'ts
Use content hierarchy, status text, numbers and separators to organize inspection. Preserve visible focus and reduced motion preferences. Avoid decorative gradients, score rings, repeated rounded card grids, decorative AI icons, glow and exaggerated shadows. Do not style a partial or failed check as a pass.

## Design grounding and checks
21st free metadata search inspected Project Management Table (`shadcnspace/table-01`, id 27611) and projects-table (`ln-dev7/projects-table`, id 2617). Reused the ideas of persistent row identity, compact status and row actions. No component code, paid retrieval, generation or new framework was used; the available components were React-oriented and the app already has Vue primitives. The 21st CLI was not installed, so its `init`/`review` commands were unavailable; metadata grounding plus native component tests and parent-owned browser acceptance substitute for those commands.

The impeccable detector ran once on the changed surface. Its two border-accent findings were mechanically addressed by reducing navigation underline thickness and replacing the error side stripe with a full thin error border. Actual desktop/mobile rendering and final acceptance belong to the parent task's computer-use pass; this document does not claim screenshots were reviewed by this implementation agent.
