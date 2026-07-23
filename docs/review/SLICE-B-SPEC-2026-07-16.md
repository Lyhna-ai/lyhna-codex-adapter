# Slice B Spec — The Receipt Proves Itself

> **Status:** Spec ready; build starts when Slice A passes its field gate. Targets CZ-3, CZ-4, CZ-8, CZ-9, CZ-10 from `CUSTOMER-ZERO-REVIEW-2026-07-16.md`. Code anchors verified at `cf260f0`.
>
> **The one-line goal:** a stranger handed only the exported packet can credit the seal, reconstruct every PR's head chain, and never climb a rung of trust the evidence doesn't support.

## Why (evidence)

Both blind readers refused to credit sealing ("close was requested, but no seal result is supplied") even though the runs sealed and verified; both flagged superseded heads presented as `CONSISTENT`; one caught `retrieved: false` child lists alongside receipt-read events with no way to establish closeout order; and the four-rung ladder (workflow succeeded ≠ no blocking finding ≠ fixed ≠ accepted) was climbable by a hurried reader because nothing in the receipt stops it.

## B-1 — Seal self-containment (CZ-8)

**Current:** the receipt carries `status: SEALED|OPEN` (`receipt.mjs:46`), but the seal anchor lives in a separate `seal-anchor.json` (`store.mjs` anchorPath), and the packet a reader receives can be a pre-seal render or a state dump with neither anchor nor closeout ordering.

**Build:**
1. The sealed receipt embeds a `seal` block: seal status, the seal-anchor hash, the ledger tip hash, event count, and per-child retrieval status *as of closeout* (not as of an earlier state snapshot).
2. Evidence in the exported receipt is strictly ledger-ordered (it already is, by `seq`) and the receipt states so on its face; the child-receipts section is derived at seal time so it can never contradict later read events.
3. `read_sealed_receipt` returns (and the markdown renders) a one-line verification statement: what the local integrity check proves and does not prove — hash-chain consistency, not adversary-resistant custody (limitation language already exists; move it adjacent to the seal block).

**Acceptance:** a blind reader given only `RECEIPT.md`/`receipt.json` states the run sealed, cites the anchor hash, and reconstructs closeout order without access to the data directory.

## B-2 — Per-PR head chains (CZ-3)

**Current:** `refreshPr` (`store.mjs:672-687`) marks a snapshot `STALE` when the head moved, but two `CONSISTENT` snapshots of the same PR at different heads both stay `CONSISTENT` (the Rooms run: `cb209…` → `345deb…`), and `checkpointOrSeal` (`store.mjs:887`) requires evaluator receipts per `CONSISTENT` snapshot without requiring any post-evaluation refresh.

**Build:**
1. At receipt build, group snapshots by `repository` + `pr_number` into a **head chain**, ordered by ledger sequence. Exactly one entry per PR may render as `CURRENT`; all earlier heads render `SUPERSEDED`; existing `STALE` stays; a final head with no post-final-evaluation refresh renders `NOT_REFRESHED`.
2. `request_close` requires, per PR with any `CONSISTENT` snapshot, a `refresh_pr` event later in the ledger than that PR's last evaluation. If the refresh cannot be performed (e.g., network), close proceeds and the receipt stamps that PR `NOT_REFRESHED` on its face — fail-honest, never silently current.
3. Markdown renders one compact card per PR: head chain with labels, checks/reviews observed at each head.

**Vocabulary guard:** chain labels are observations of recorded events (`CURRENT` = refresh observed after final evaluation with unchanged head). No permission vocabulary.

**Acceptance:** for a run covering a PR whose head moved mid-run, the receipt shows exactly one `CURRENT` head and the predecessor as `SUPERSEDED`; a run sealed without refresh shows `NOT_REFRESHED`; the Rooms-run shape can no longer render as two undifferentiated `CONSISTENT` entries.

## B-3 — The semantic ladder, explicit (CZ-9)

**Current:** the receipt renders observed check counts and evaluation statuses; nothing prevents reading "Claude Code Review: SUCCESS" (a check-run name) as "approved" or "comments resolved."

**Build:** the receipt renders four distinct, labeled statements per PR head, asserting only supported rungs:
1. *Workflow checks:* "check-run named X: state Y" — named as check-runs, never as review outcomes.
2. *Independent evaluation:* status + whether the evaluator's finding statement was retrieved (by hash reference).
3. *Findings addressed:* asserted only when a later head chains to a later clean evaluation — otherwise "not established by this record."
4. *Acceptance:* always rendered as "not a rung this receipt can assert — acceptance is the operator's decision," constitutionally.

**Acceptance:** a blind reader cannot quote the receipt to support "approved/fixed/accepted" beyond what rungs 1–3 explicitly state; rung 4 always names the boundary.

## B-4 — Temporal coverage boundary (CZ-4)

**Current:** the coverage block lists configured hooks and the absence caveat (`receipt.mjs:50-53`); nothing states when witnessing began relative to the goal or that no delegated children were observed.

**Build (structural only, no wall-clock claims):**
1. The coverage block states invocation evidence: matched form and offset when the front door fired (Slice A's `invocation` payload), or "no hook-observed invocation preceded this run" when `agent_reported`.
2. When `children` is empty: the explicit line "No ordinary delegated-child lifecycle was observed during this run." When the run began after session activity (a pending miss or later `run_begun` seq), state "witnessing began at this run's first event; earlier session activity was not observed."

**Acceptance:** the Rooms-run ambiguity ("were subagents used before the run?") is answerable from the receipt text alone.

## B-5 — Self-explaining evaluations and objective (CZ-10)

**Current:** the objective synopsis is already on the receipt (`objective`, structural summary — CZ-10's objective half is largely done); duplicate same-head evaluations carry no scope distinction.

**Build:** `begin_evaluation` accepts an optional structural `trigger` enum — `initial` | `post_fix_reeval` | `gate_audit` | `re_examination` — recorded on the evaluation and rendered on the receipt; absent means `unspecified` (never inferred).

**Acceptance:** two evaluations at the identical head are distinguishable by trigger on the receipt face.

## Constraints (all standing rules apply)

Deterministic (no clock, no randomness, no model calls); zero new dependencies; additive schema only — builder's step 0 is to confirm whether existing verifier/tests tolerate additive receipt fields and whether the schema string moves to `…-receipt.v1`; no permission vocabulary anywhere; version bump with all three surfaces via the shared constant; every change lands with fixtures, including one that replays the Rooms-run shape (multi-head PR, sealed with and without final refresh).

## Slice gate (field)

Re-run the blind-reader test on a sealed packet from a real run: the reader credits the seal, reconstructs the head chains, and produces no correction in the CZ-8/9/10 families.
