# Build Plan — Slices A–H and the Cross-Platform Loop

> **Provenance.** Written 2026-07-16 by the lead session (Claude, Fable) on Adam's direction to take the build lead. This operationalizes the customer-zero work order (`CUSTOMER-ZERO-REVIEW-2026-07-16.md`, Part C) and the reclamation ladder (`FULL-VISION-ROADMAP-2026-07-16.md`) into an execution plan.
>
> **The settled premise (Adam, 2026-07-16):** six months ago the receipt was for humans. That has changed entirely and the customer-zero evidence proved it — **the feed to both human and agent is the value.** Every slice below serves both readers.

---

## 1. The operating loop (every slice runs this way)

1. **Spec** — the lead specs the slice from the work order and roadmap, with acceptance criteria written before code.
2. **Build** — Opus builder subagents implement. Builders never review their own work.
3. **Review, three ways** — an independent adversarial reviewer subagent attacks the diff; the lead reviews everything; the push to the PR triggers hosted **Codex review** on GitHub — the cross-platform brain check (two different model families reading the same diff).
4. **Field test** — Adam runs the installed plugin on real builds in his other projects (the Rooms pattern). The receipts and host-surface evidence come back to this session for evaluation. **The plugin in the field is the delivery vehicle and the test harness at once.**
5. **Gate** — a slice is done when its field gate passes, not when CI is green. This rule exists because of finding F2: the project has already been burned once by green checks that proved nothing about the runtime.

Roles, standing: *The builders produce (Opus subagents here; Codex in the field). The evaluators examine (adversarial subagents, hosted Codex review, blind readers). Lyhna witnesses (the plugin on Adam's real builds). Adam decides.*

## 2. The slices

### Slice A — The Front Door *(today)*
CZ-1 + CZ-2. Permissive invocation matcher (mention anywhere; long-form `@lyhna-codex-adapter`; structured serialization; structural miss-markers for unknown host forms; opt-in raw diagnostic), invocation evidence threaded into the run record, and the full-vs-pr_only selection rule in the skill and tool descriptions.
**Field gate:** Adam's next real invocation shows `objective_origin: runtime_hook` from message one, `full` mode, and the matched form on the receipt.

> **Build record (2026-07-16).** Code complete at `cf260f0`, v0.1.25, 37/37 tests, validator green. The loop ran exactly as designed: Opus builder shipped clean; the Claude adversarial pass found six coverage bypasses (fully-qualified form, boundary asymmetry, markdown wrappers, `@`-less link text, structured-payload coercion, plus growth/e2e gaps); hosted Codex found seven progressively narrower real defects across eight review rounds (URI prefix boundaries, raw-dump privacy — which forced the masked mention-context design, underscore then Unicode trailing boundaries, Unicode leading boundaries, prompt-part URI preservation, bare-URI leading boundary) and one docs suggestion declined with rationale (runtime privacy rule misapplied to the constitutionally-frozen thesis text). Final Codex verdict on `cf260f0`: no major issues. Nine threads, eight fixed with tests, one declined; 32 matcher fixtures across four scripts. Principle distilled mid-loop and now standing: **a wrong `runtime_hook` stamp is an evidence overclaim — false positives are not free at the evidence layer of a witness product.** The raw diagnostic was replaced by content-free masked mention contexts for the same reason. Awaiting the field gate.

> **Field gate (2026-07-17): PASSED.** A fresh Codex task on v0.1.25 (skill read from the `0.1.25` cache paths), first message carrying the mention as a markdown plugin link — `[@lyhna-codex-adapter](plugin://lyhna-codex-adapter@lyhna-ai)` — followed by a real goal (review/continuation planning for a derailed prior thread). `begin_run` returned `run_5c99171b-b85c-4fc0-8c32-08be9a480c6a`, `mode: full`, `objective_origin: runtime_hook`, `status: OPEN`. The CZ-2 run-type rule also held in the field: a continuation-planning request selected `full`, not `pr_only`. Corroborating negative evidence from the same day: two invocations in the *continued* old Rooms thread correctly remained `agent_reported` (hooks bind at session start; an old thread keeps the old plugin) — not gate evidence, and the matcher correctly did not overclaim. The sealed receipt's `invocation.matched_form` is to be appended to this record when the run closes. Slice B build authorized and launched per handoff §5. Full evidence note: `FIELD-EVIDENCE-2026-07-17.md`.

### Slice B — The Receipt Proves Itself
CZ-3, CZ-4, CZ-8, CZ-9, CZ-10, plus CZ-11 and CZ-12 (folded in 2026-07-17). Enforced post-evaluation refresh or a `NOT_REFRESHED` stamp; per-PR head chains (`CURRENT`/`SUPERSEDED`/`STALE`); seal result, parent receipt ID, and per-child retrieval status inside the exported packet, chronologically ordered; the explicit semantic ladder (workflow-check ≠ no-blocking-finding ≠ fixed ≠ accepted); sanitized objective synopsis and per-evaluation triggers.
**Field gate:** a blind reader with no Lyhna knowledge credits sealing and reconstructs the head chain from the packet alone.

> **Build record (2026-07-17).** Code complete at `c837584`, v0.1.26, 60/60 tests (37 inherited + 23 new fixtures), validator green, CI green; PR #3 (stacked on PR #2's branch). The loop ran as designed. Opus builder shipped the seven items; the lead caught literal NUL bytes in source pre-review (file rendered binary to git — diff would have been unreviewable). The Claude adversarial pass found one P0 (the "findings addressed" rung fired off `RECORDED`, which attests checkout integrity only — rung 3 is now constitutionally constant, "Not established by this record", until a structural clean-evaluation signal exists), one P1 (the new renderer's seal re-render check made every pre-0.1.26 sealed run unreadable — fixed with a renderer-version gate), two P2s (missing witnessing caveat on hook-origin runs; same-head snapshots faking a SUPERSEDED progression), three P3s (marker cap, locale-dependent sorts in hashed renders, an extra field on the CZ-11 marker), and four fixture gaps — all accepted, all fixed. Hosted Codex then ran seven rounds: six real, progressively narrower findings, all fixed with replaying fixtures, none declined — (1) anchor-field deletion downgraded seal verification → renderer version pinned in the hash-chained `run_sealed` event; (2) same-head re-evaluation lost its trigger to snapshot de-dupe → occurrence-suffixed evaluations; (3) force-push away-and-back collapsed STALE into CURRENT at render → divergence-aware chain splits; (4) the same collapse at the store level, where `addPrSnapshot` silently resurrected STALE → CONSISTENT with no event → occurrence-forked snapshot records; (5) the post-evaluation refresh deduped against an earlier same-head refresh, stamping honest runs `NOT_REFRESHED` → evaluation-count in the refresh idempotency key; (6) an inconsistent capture poisoned the next clean capture's label → inconsistent captures split like STALE. Round-7 verdict on `c837584`: no major issues. Theme distilled: **idempotency keys and state overwrites must discriminate semantically distinct observations — the ledger is the truth, state is a cache of it.** Awaiting the field gate: install 0.1.26, one real run sealed and closed, packet to blind readers.

### Slice C — Full Vision (stop discarding the fuel)
Roadmap Step 1 + CZ-5 + CZ-6. Rich Tier-0 local capture (payloads, claims, evaluator findings — readable), hash-bound to the sealed receipt; tiered projection at every export boundary (structural spine + argument commitments + sidecar by explicit choice, validator-enforced); structural-identity fields on every consequential event; the value-free sensitive-output observation.
**Field gate:** a receipt reads end-to-end for human and agent; structural fields on 100% of consequential events; zero raw content in boundary exports.

### Slice D — The Dual Axis + The Cockpit
Roadmap Step 3 (observational vocabulary only: `PROCEEDED`/`HELD`/`TURNED_BACK`/`GATE_STOPPED`/`REDONE`, every label traced to a witnessed external event) + CZ-7 (Sources-pane run cards, opaque checkout handles, receipt link at closeout).
**Field gate:** a blind reader reconstructs what the environment did without prose — and cannot mistake any of it for something Lyhna decided.

### Slice E — The Corpus
Roadmap Step 4. Cross-run receipt inbox/index; deterministic grouping by structural identity ("every deploy-shaped decision across 30 runs").
**Field gate:** Adam or Adam's agents actually query it weekly.

### Slice F — The Reducer (read-only, forever)
Roadmap Step 5. Consistency, determinism, escalation stability, drift, per-domain health grade — deterministic, offline, no model calls. **Kill-guard: the moment any score blocks execution, that change is reverted — measurement never gates.**
**Field gate:** a metric changes a real decision (a domain automated or de-automated because of the read).

### Slice G — Two Readers, Productized
Roadmap Step 6. Agent-reader: loading the prior receipt through the witnessed read tool becomes the first act of every run. Human-reader: decomposed, weighted, "what's-driving-it" reports on the human surfaces.
**Field gate:** a receipt or health-read voluntarily shown to someone else; measurably better next-run behavior.

### Slice H — The Outward Product
Roadmap Step 7. Agent-Readiness Map, per-domain judgment-health trending, portable signed health nodes, Tier 1 countersigning the day anything faces a third party.
**Field gate:** G4 — someone who isn't Adam pays.

## 3. Standing rules

- One live edge at a time; a slice ships only when the one below passed its field gate.
- The honesty ceiling is constitutional in every slice; the permission vocabulary is banned from schemas and surfaces.
- Blind at the boundary, never at the eyes: disclosure is tiered at export; capture is never impoverished to make export easier.
- Every slice's evidence (field receipts, blind reads, Codex reviews) is appended to the review record so no future session has to re-derive this.

*The builder produces. The evaluator examines. Lyhna witnesses. The corpus grades. Adam decides.*
