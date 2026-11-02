# Consumer impact demonstration

These synthetic retail examples exercise consumer evidence separately from provider-contract differences. They are not recordings from real customers or a comparative accuracy benchmark.

- [baseline.json](baseline.json): released provider contract.
- [candidate.json](candidate.json): proposed provider contract.
- [consumers.json](consumers.json): three named consumers, three interactions, four request/response checks, with owners and explicit response expectations.

From the repository root after building:

```powershell
pnpm.cmd contractguard compare fixtures/consumer-impact/baseline.json fixtures/consumer-impact/candidate.json --consumer-evidence fixtures/consumer-impact/consumers.json --format markdown
```

The expected exit code is `2`: the fixture deliberately contains release-blocking examples.

| Consumer | Check | Expected result | Independent reason |
| --- | --- | --- | --- |
| Mobile checkout | Request | Regression | The caller buys one item; the candidate requires at least two. |
| Mobile checkout | Response | Regression | The supplied candidate body omits `receiptUrl`, which the checkout consumer requires. Both provider response schemas still permit its omission. |
| Revenue dashboard | Response | Pass for supplied examples | Both bodies satisfy the unchanged provider schema and dashboard assertion. |
| European inventory sync | Request | Regression | The caller still requests `region=eu`; the candidate only accepts `us`. |

Expected summary: **3 consumers, 3 interactions, 4 checks, 3 regressions, 1 pass, 0 invalid baselines, 0 inconclusive checks**, with three migration tasks. Checkout tasks have high priority because its manifest marks the consumer as critical.

To isolate the evidence-only capability, compare the baseline to itself while using the same evidence:

```powershell
pnpm.cmd contractguard compare fixtures/consumer-impact/baseline.json fixtures/consumer-impact/baseline.json --consumer-evidence fixtures/consumer-impact/consumers.json --format json
```

This produces **zero static contract findings** but **one response-evidence regression**: the missing checkout receipt. It demonstrates an additional input and workflow beyond document comparison; it does not demonstrate that the static rule engine is more accurate than another tool.

To create an explicit portable replay artifact:

```powershell
pnpm.cmd contractguard compare fixtures/consumer-impact/baseline.json fixtures/consumer-impact/candidate.json --consumer-evidence fixtures/consumer-impact/consumers.json --write-regression-pack retail-regression.json
pnpm.cmd contractguard verify-pack retail-regression.json --format markdown
```

Both commands are expected to report regressions and return `2`. Packs contain the submitted contract and example text; use sanitized examples and deliberately choose where to keep/share them. The ordinary saved report contains issue paths, owner metadata, and an evidence fingerprint, without retaining the submitted payload bodies. No request is sent to the retail service, and no LLM call is made by these commands. These examples verify schema/body assertions, not payment processing, credentials, HTTP serialization, deployed behavior, or production traffic coverage.
