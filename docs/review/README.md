# Evaluator Review Record

> **Status (2026-07-26): ACTIVE — shipping from `main`, nothing in flight.** `main` is at **v0.1.31** (`539e67f`), published as an installable release bundle by the release workflow on merge. The v0.1.30 bundle before it was **proven cold** — installed from the zip with no repo and no `npm install`, driven through a two-window lineage chain, tamper-checked — and that run is what found the `verify:lineage` reporting defect #10 fixed. **Thesis v2 was ratified on 2026-07-25** and is now canonical, with two recorded amendments. Slice A remains closed and field-proven. Slice B and CZ-14 are code-final; **both blind-reader field gates are still owed**, and no gate run has been recorded since 2026-07-23. **There are no open PRs.** The full stack (PRs #1–#3) merged 2026-07-23; #6–#10 have merged since; #4 and #5 were closed 2026-07-26 as superseded, their documents landed here first.

Independent third-party evaluation record for the Lyhna Codex Adapter and the Lyhna product direction. Assembled by the evaluator session at Adam's direction; nothing here approves, certifies, or merges anything — canonical/adoption status of every document is Adam's decision.

**Taking over from a prior session?** Read the status banner above for current state — it is maintained; the handoff documents are not. Then [HANDOFF-2026-07-23.md](HANDOFF-2026-07-23.md) for the role, the standing rules, and the working relationship, reading it as **historical**: its state table stops at v0.1.27 and its §3 still lists Thesis v2 adoption as open. Then [HANDOFF-2026-07-16.md](HANDOFF-2026-07-16.md) for the constitution and the operating loop, which remain binding.

Then read [SPEC.md](../../SPEC.md) at the repository root — the evidence contract and honesty boundaries the code is reviewed against. It is the standard, not a summary of one.

## What has shipped since the 2026-07-23 stack merge

| PR | Version | What landed |
|---|---|---|
| #6 | 0.1.28 | A verified window handoff folded from the ledger, with a cross-window lineage check that proves the chain — the continuation lane promoted to a product surface (Thesis v2 Amendment A). |
| #6 | 0.1.29 | Builder claim text **retained** rather than reduced to a byte count; Verified Context becomes the default and content-blindness becomes `privacy_mode: proof`, an export projection (Amendment B). Thesis v2 ratified in the same commit. |
| #7 | 0.1.30 | Capsule **signing** — a content address becomes a citation; key protection reported honestly by platform instead of claiming owner-only. |
| #8 | 0.1.30 | The request retained, not its byte count; release cut automatically on a version bump so no one hand-pushes a tag. |
| #9 | 0.1.30 | The release creates its own tag via `gh release create`, removing the `git tag -a` step that had no committer identity on a runner. First successful release: **v0.1.30**. |
| #10 | 0.1.31 | `verify:lineage` emits a fixed check sequence with `NOT RUN` plus a reason instead of silently dropping checks it could not evaluate, and reads a packet totally — a destroyed input is a recorded FAIL rather than a throw that costs every later hop. First change to go through an independent agent review against `SPEC.md` before merge. |

## Reading order

1. **[THESIS-V2.md](THESIS-V2.md)** — **canonical product thesis, ADOPTED 2026-07-25.** Body preserved verbatim per the adoption terms; two amendments recorded in the header (the continuation lane as a first-class surface; Verified Context as the default). Read this first — it is the only document here with settled status.
2. **[CUSTOMER-ZERO-REVIEW-2026-07-16.md](CUSTOMER-ZERO-REVIEW-2026-07-16.md)** — findings from the first real customer-zero run (ChatGPT Work, Homestead repos), the product verdict, and the CZ-1–CZ-12 findings ledger the slices are built from.
3. **[FIELD-EVIDENCE-2026-07-17.md](FIELD-EVIDENCE-2026-07-17.md)** — the field record: both Slice A gate passes, the CZ-12 amendment, CZ-13 and its escalation, the seal-at-Stop verifications, the banked baseline packet, and the 07-22 addenda (the CZ-14 thesis observed verbatim; the continuation-reader vs. audit-reader distinction). Newest evidence, last appended 2026-07-22.
4. **[BUILD-PLAN-2026-07-16.md](BUILD-PLAN-2026-07-16.md)** — the master plan: slices A–H with their field gates, the operating loop, standing rules, and the build records for Slices A, B, and CZ-14.
5. **[FULL-VISION-ROADMAP-2026-07-16.md](FULL-VISION-ROADMAP-2026-07-16.md)** — the seven-step reclamation ladder with falsifiable gates, the never-judge/never-show distinction, and the Step 5 kill-guard.
6. **[LYHNA-REVIEW-DOSSIER.md](LYHNA-REVIEW-DOSSIER.md)** — the evidence record behind Thesis v2: the 2026-07-15 PR #1 evaluation (F1–F6), strategy-grade maps of `lyhna-mcp-proxy` and `lyhna-witness`, three adversarial reviews (buyer/GTM, platform/competition, technical evidence-value), the convergence table, and the source index.
7. **[SLICE-B-SPEC-2026-07-16.md](SLICE-B-SPEC-2026-07-16.md)** — Slice B's spec, the standard for how a slice is specified before it is built. Built; CZ-11/CZ-12 folded in 2026-07-17.

## Handoffs

Superseded handoffs are preserved verbatim rather than rewritten — the directory's standing idiom. Read them for the reasoning of their window, not for current state.

| Document | Status |
|---|---|
| [HANDOFF-2026-07-16.md](HANDOFF-2026-07-16.md) | **Binding** for the role, the constitution, and the operating loop. Its state table is historical. |
| [HANDOFF-2026-07-18.md](HANDOFF-2026-07-18.md) | Historical. Landed 2026-07-26 from the closed PR #4; never in `main` during the window it describes. |
| [HANDOFF-2026-07-22.md](HANDOFF-2026-07-22.md) | Historical. Its §3 CZ-14 spec shipped; the outcome is in the build plan. |
| [HANDOFF-2026-07-23.md](HANDOFF-2026-07-23.md) | Historical, and the most recent full handoff. Landed 2026-07-26 from the closed PR #5. |

## What is owed

- **The Slice B and CZ-14 blind-reader field gates**, both Adam-paced. They run when he next uses the witness and a packet exists — a sealed packet for Slice B, a cold open packet for CZ-14. Acceptance criteria are in `HANDOFF-2026-07-23.md` §2 and the build plan. Per *one live edge at a time*, **Slice C does not start until Slice B's gate passes.** Do not manufacture a run to force a gate, and do not route witness errands through Adam's working agents (CZ-13).
- **Nothing is in flight.** No open PR, no build started. The next build is Slice C, and it is gated on Slice B's field gate above.
- **Slice B2 is retired — not owed.** Adam's call, 2026-07-26: the work moved past it. The spec still appears in `HANDOFF-2026-07-18.md` §1 and §4 because that document is preserved verbatim; read it as history, not as a build. Do not revive it from there. The retirement is recorded in `BUILD-PLAN-2026-07-16.md`.

Two gaps named here on 2026-07-26 were closed the same day: the missing PR #6–#10 build records are now in `BUILD-PLAN-2026-07-16.md` (compiled after the fact, and labeled as such), and the cold-install proof of the published bundle is recorded in `FIELD-EVIDENCE-2026-07-17.md`.

Timeline context: the F1–F6 findings in the dossier were made against PR #1 head `f61de1e`; all six were closed by the builder at head `013c70f`. The customer-zero review was made against a live run of the installed adapter plus code inspection at `013c70f`, and defines CZ-1 through CZ-7. Slice A's gate passed twice in the field on 2026-07-17. The full stack merged to `main` on 2026-07-23 at v0.1.27; the continuation lane, Verified Context, and capsule signing landed across 2026-07-24/25, and v0.1.30 was published as a release on 2026-07-25. Running that published bundle cold on 2026-07-26 found the `verify:lineage` reporting defect, which shipped as v0.1.31 the same day.

*The builder produces. The evaluator examines. Lyhna witnesses. The corpus grades. Adam decides.*
