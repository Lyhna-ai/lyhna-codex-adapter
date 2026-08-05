# PROPOSAL — Lyhna Witness claim compiler

**Status: QUARANTINED PROPOSAL. Ratification is Adam's. Nothing in this document changes runtime
behavior, the shipped SPEC.md contract, or any released packet format until Adam ratifies it and
the slices below are built and accepted.**

## Provenance

This proposal merges three convergent diagnoses of one recurring failure, produced on 2026-08-05
while examining a failed Homestead phase build:

- **The control failure** (Codex): completion is narrated by the builder, not compiled from
  terminal evidence. A merge proceeded while a requested reviewer was still running; a completion
  summary claimed zero unresolved findings nine seconds before two real P2 defects arrived.
- **The decay failure** (Fable): prose lessons do not hold under context pressure; only enforced
  lessons hold. The same failure was logged three times as three "first observations" because
  recurrence detection was itself prose.
- **The architecture requirement** (Adam): contradictions must be caught inline, during the build,
  as evidence arrives — not discovered at the end of a phase by the owner acting as the
  integration test.

The synthesis in one sentence: **compile the strongest completion claim that current terminal
evidence supports, inline, and refuse any claim that exceeds it at a declared gate.**

This is not a new product bolted onto Lyhna. It is the adapter's existing theorem at a larger
radius. `REFERENCES_RESOLVE` exists because "cites something real" must not read as "verified."
The claim compiler applies the same rule one level up: "has repo-side evidence" must not read as
"works in production." Same collapse, same cure — a deterministic fold over witnessed evidence,
with the agent's narration never accepted as proof of anything.

## Goal

An independent, cross-project capability of the Lyhna Witness plugin: the user activates a
witnessed session with a declared goal, completion class, reviewers, and gates; hooks — not the
agent's memory — carry the loop; a deterministic compiler folds evidence into the highest
supportable completion state as evidence arrives; contradictions surface inline during work and
fail closed at declared gates; the sealed receipt states the compiled class, never the narrated
one.

Homestead is the first demanding customer and the acceptance environment. It is never a
dependency: no Homestead concept (Door, Librarian, Keep, Cards, organ heartbeats) enters the core
schema. Homestead supplies a profile and probe implementations, exactly as any other project would.

## What this is not — the honesty ceiling, preserved

The shipped contract says the adapter "never approves, blocks, certifies, merges, or declares the
work … correct." That line survives this proposal intact, resolved as follows:

- **The compiler blocks the claim, not the action.** At a declared gate it refuses to seal a run
  whose stated completion class exceeds its compiled class — or seals it with the honest
  downgraded class stated in the record. It does not merge, deploy, or prevent merging or
  deploying. External enforcement (branch protection, deploy scripts, CI gates) consumes the
  machine-readable verdict where action blocking is wanted.
- **It never judges correctness.** `LIVE_PROVEN` means "a dated real canary proved this bounded
  scenario at this time," not "the work is right." Reviewers (Codex, Fable, humans) remain the
  judges of reasoning; the compiler only records whether their judgments are requested, running,
  terminal, at which exact head, with what findings, and whether later evidence superseded them.
- **A verdict is a statement about evidence relationships**, in the exact form: "the available
  evidence supports BUILT, not LIVE_PROVEN," with the missing producers named.

## Claim classes — the surface vocabulary

Four classes, each requiring named terminal evidence. The bare word "works" is forbidden output at
every class:

1. **BUILT** — exact source head identified; declared executable checks green at that head.
2. **MERGED** — that exact head (or its merge commit) proven present on the named remote base.
3. **DEPLOYED** — running artifact identity proven equal to the merged head, with required
   configuration proven present (presence, never values).
4. **LIVE_PROVEN** — a dated, real (non-mock) canary proved the end-to-end effect: durable
   resulting object or terminal state, reconciliation result, and replay behavior where the
   profile requires idempotency.

Generated language always states class, scope, and date — "Live-proven for arrival → judgment →
durable effect as of 2026-08-05" — never an unbounded predicate.

Internally the compiler models a **prerequisite graph, not a universal ladder**. The eight-state
Homestead sequence (implemented → tested → reviewed → merged → deployed → configured →
live-exercised → reconciled) is one project's release profile. Other profiles may order
configuration before deployment, omit review, or add domain states. The four surface classes are
projections of whatever graph the active profile declares.

## Evidence contract extensions

All compiler evidence lands on the **existing hash-chained ledger** as new witnessed event types —
no second ledger. Candidate types (names settled at build time, versioned like every event):
`claim_contract_declared`, `producer_requested`, `producer_terminal`, `check_observed`,
`merge_identity_observed`, `deploy_identity_observed`, `config_presence_observed`,
`probe_receipt`, `gate_evaluated`, `claim_compiled`.

Standing rules, inherited from the existing contract and extended:

- **Witnessed, never narrated.** An agent statement about evidence ("I ran the canary," "the
  reviewer finished") is `agent_reported` and satisfies no requirement — ever. Requirements are
  satisfied only by producer receipts: adapter probes whose raw outputs are hashed into the chain
  with their origin stated.
- **Mocks cannot satisfy production requirements.** Every DEPLOYED/LIVE_PROVEN producer receipt
  carries identity binding — deployed artifact hash tied to the merged head, canary tied to the
  deployed identity — the same authentication pattern the capsule archives use (content ref plus
  residence in the chain). A mock proves logic under BUILT; it cannot mint a production identity.
- **Append-only invalidation.** Later evidence never rewrites an earlier compiled state or
  learning entry; it appends a superseding disposition that names what it invalidates. Historical
  claims remain readable exactly as they were made.
- **Currentness is explicit.** Every compiled state carries the evidence timestamps it rests on.
  A profile may declare staleness horizons; a stale LIVE_PROVEN automatically reads as
  "was live-proven as of <date>," never as present tense.

## The compiler

A pure, deterministic, fold-versioned reducer over the chain — the same species as the
continuation folds, subject to the same discipline learned across twelve adversarial review
rounds:

- Input: the declared claim contract plus all witnessed evidence events. Output:
  `highest_supported_state`, `missing` (named absent producers), `pending_producers` (requested
  but non-terminal), `contradictions`, `currentness`, and the exact next verifier.
- **No LLM anywhere in the compiler.** Not for evidence relationships, not for recurrence
  identity, not for gate decisions. The moment a model judges "done," narration has re-entered at
  the exact point this exists to remove it.
- The agent does not select its own completion class. The reducer does. The agent may state a
  *requested* class; the compiled class is what the record carries.
- Compiler outputs are themselves witnessed events, so the receipt, handoff, and lineage
  machinery render and verify them with zero new trust surface.

## Gates and the join barrier

- **During work:** a contradiction or staleness produces one de-duplicated inline advisory
  (`PostToolUse` / `SubagentStop` transport). Unchanged evidence never repeats the warning; fresh
  proof resolves it. Work is not blocked.
- **At a declared gate** (merge, deploy, done/seal — the profile names them): missing or pending
  required evidence **fails closed**. No gate passes while any requested producer — reviewer,
  check, sync hook — is non-terminal.
- **The quiet-period contract is deterministic:** two samples separated by a configured interval,
  with unchanged head, reviewer set, check set, unresolved-thread state, and evidence-producer
  cursors. Both samples are witnessed events. (This is the codified form of the loop run by hand
  on this repo's own PR #12: exact-head re-requests, reviewer terminal before round closure,
  resample after the last producer finishes.)
- **At Stop:** the existing seal path additionally compares declared goal-class against compiled
  class. A materially false closeout is refused or sealed with the downgraded class stated —
  "Built, with mocked delivery — never Deployed, never Live-proven" is a legal sealed sentence;
  "works" is not.

## Packaging

```
lyhna-codex-adapter (this repo)
├── Skill          — activation: goal, requested class, reviewers, gates, caps, exact verifier
├── Hooks          — existing transport; carries the loop after activation
├── Claim compiler — deterministic evidence-state engine (new fold)
├── Ledger         — the existing hash-chained events.jsonl; evidence events are new types on it
├── Gate profiles  — declarative requirements per class per gate; generic core vocabulary
└── Receipt        — existing renderer, extended to carry compiled class and evidence map
```

Core vocabulary stays generic: `claim`, `required_evidence`, `observed_evidence`,
`pending_producer`, `contradiction`, `currentness`, `highest_supported_state`,
`missing_verifier`, `gate_result`. Customer concepts live in profiles and adapters only.

## Profile and adapter contract

- A **profile** declares, per gate, the required evidence for each claim class, orderings in the
  prerequisite graph, staleness horizons, and idempotency requirements. Profiles are data, not
  code, and are witnessed into the run at activation.
- An **adapter** produces evidence: tests, GitHub review/check state at exact heads, deployment
  identity, configuration presence, live probes, business receipts. Adapters run outside the
  compiler and submit receipts through the witnessed surface; the compiler never fetches.
- First-party adapter for Slice 3: **GitHub** — reviewer requested/running/terminal, verdict,
  exact head reviewed, findings as structured data (a review job that executed green while posting
  findings is *not* a clean review), unresolved threads, merge identity.
- The Homestead Librarian profile (arrival → authenticated receiver → judgment → durable effect →
  terminal state → sync → replay) lives in Homestead's repo, as the first customer profile.

## Recurrence reducer

- Every failure candidate carries a stable, deterministic `failure_class_id` assigned by rule,
  not by model judgment.
- A confirmed recurrence of the same class becomes `ENFORCEMENT_REQUIRED`: an appended build
  obligation naming the gate that must exist. It is never silently re-logged as a first
  observation, and the reducer never autonomously builds or deploys the control — it opens the
  obligation for a human-sequenced build.
- Standing meta-rule, already ratified by Adam in the Homestead lane and adopted here: any lesson
  that recurs twice graduates from prose to enforcement in the next build cycle.

## Build order — four slices, one PR each, DONE WHEN proven by deliberate mutation

1. **Contract + compiler + Stop gate.** Claim contract declaration, evidence event types, the
   deterministic compiler, compiled-class rendering in receipt/handoff, Stop-gate downgrade.
   DONE WHEN the Librarian incident, replayed from its actual evidence, compiles to exactly
   "BUILT — missing: configured receiver, real canary, durable effect, terminal state, replay
   proof," and a closeout claiming LIVE_PROVEN is refused.
2. **Join barrier.** Pending-producer tracking, gate fail-closed, deterministic quiet period.
   DONE WHEN a seeded merge-during-review is refused; a late finding invalidates a prior clean
   state exactly once by appended disposition; unchanged evidence produces no repeated warning.
3. **Production-proof envelope + GitHub adapter.** Identity-bound deploy/config/canary receipt
   schema; the GitHub evidence adapter. DONE WHEN a seeded green-executing review job carrying a
   P2 finding fails the gate, and a mocked canary cannot satisfy a LIVE_PROVEN requirement.
4. **Recurrence reducer.** DONE WHEN three seeded candidates of one failure class yield one
   `ENFORCEMENT_REQUIRED` obligation — not three first observations.

Caps, per Codex's bound and adopted here: one week, twelve repair turns, zero model calls inside
the compiler, two no-progress cycles. Stop conditions: it becomes a dashboard, a
receipt-formatter, another reviewer agent, or needs an LLM to determine evidence relationships.

## Acceptance

- Every slice goes through the same adversarial protocol that produced v0.1.32: independent Codex
  review at exact heads, every finding reproduced before fixing, every fix pinned by a fixture
  proven red on the previous head, loop until clean. The compiler that gates claims must itself
  be Codex-clean before it gates anything.
- Adversarial fixtures are first-class: forged producer receipts, planted evidence with honest
  content hashes, stale verdicts presented as current, rewritten history, mocks dressed as
  production — all must fail closed, by the same "the gate must precede the grant" discipline.
- If Slice 1 cannot stop the exact Librarian false claim before closeout, the product bet ends
  there.

## Repository boundary

- Engine, plugin surface, generic profiles, and the GitHub adapter live in
  `Lyhna-ai/lyhna-codex-adapter`. `lyhna-witness`, `lyhna-mcp-proxy`, and `lyhna-core` remain
  untouched.
- Customer profiles and probes (Homestead first) live in customer repositories.
- Naming, per the review consensus: the product is **Lyhna Witness**; the capability is the
  **claim compiler** (evidence compiler); the customer integration is a **completion gate**.
  "Truth Gate" is rejected — this proves evidence relationships, not truth.

## Decisions that are Adam's

1. Ratify this proposal (with or without amendment) as the v0.1.33+ line of this repo.
2. Sequencing against the parked slices (Slice B / CZ-14 blind-reader field gates, Slice C):
   recommendation — Slice 1 next, field gates unchanged in their parked state.
3. Whether the recurrence meta-rule is promoted into this repo's own working agreements now or
   at Slice 4.
