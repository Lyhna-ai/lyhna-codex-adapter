# The Full-Vision Roadmap — Reclaiming Build 6/7 in Today's Stack

> **Provenance.** Written 2026-07-16 by the evaluator/strategist session, at Adam's direction, after reviewing the full project history (January AXLIO thesis → the June 8 Context Graph Recovery Record → the June 29 Kinetic Context Layer retrospective) against the current adapter, witness, and proxy state and the customer-zero evidence of 2026-07-15/16.
>
> **What this is.** The multi-step plan to recover the project's original asset — the rich, self-scoring, decision-trace context graph of Build 6/7 — on top of the capture position and honesty discipline that now exist. Step 1 is already in the current work order; the ladder runs to Step 7 deliberately.
>
> **Companions:** `THESIS-V2.md`, `LYHNA-REVIEW-DOSSIER.md`, `CUSTOMER-ZERO-REVIEW-2026-07-16.md`.

---

## 0. The finding that motivates this document

The recurring failure across every Lyhna era is a conflation of two different disciplines:

- **"Never judge"** — the honesty ceiling: don't certify correctness, don't gate, don't become the authority. Correct, load-bearing, praised by every reader class in the customer-zero evidence. **This is the moat. It never changes.**
- **"Never show"** — content-blindness, hash-only records. **Not original.** The December Build 6/7 decision traces were rich — full payloads, full context, full outcome. The blinding was introduced with bind/authority (Build 8) and survived even the June 8 recovery that correctly demoted authority to "one field." It is authority's residue, and in the blind-reader test of 2026-07-16 five independent readers handed the project the invoice for it: every one was stopped at the same "retained by hash" wall.

The correction: **blind at the boundary, not at the eyes.** Disclosure is not judgment. Capture everything; project down at export by tier; certify nothing. That single principle is what this roadmap builds on.

## 1. Why now is different from January

January's version was theory plus research with no means of implementation. Three things changed:

1. **The capture position exists.** Plugin/hook surfaces (Codex plugins, Claude Code hooks) put the witness *inside* the agent at the decision moment — prompts, tool calls, subagent lifecycle, permission requests, gate stops. The 487-event customer-zero run is the existence proof. Bind had to stand *in front of* the action partly because nothing could stand *inside* the loop; that constraint is gone.
2. **The build crew exists.** Coding agents can now lead the assembly — and the adapter itself witnesses the loop that builds it. The product is its own QA harness; dogfooding compounds.
3. **The category arrived.** Context graphs and second brains are everywhere. The market's demand object and the December build are the same category — with one difference nobody else has: the memory-store race optimizes for re-derivable content; Build 6/7 is sealed-at-the-event, intended-vs-actual, with proof. *It doesn't just remember. It grades.*

## 2. The ladder

Dependency-ordered. Each step is cheap once the previous one exists. The sequencing rule (one live edge at a time, Thesis v2 §14) governs the *pace*, not the *ambition*: the ladder is the destination; the rule just forbids climbing two rungs at once.

### Step 1 — Stop discarding the fuel *(joins the current slice)*

Rich local capture, tiered projection:
- Full decision traces retained in the **Tier-0 local record**: payloads, claims, evaluator statements, results — readable, hash-bound to the sealed receipt (CZ-5 built as *rich-capture-with-tiered-projection*, not as a legibility patch).
- **Structural-identity fields** stamped on every consequential event (action family, decision shape, target class, response class, timing) — the descendant of 6/7's deterministic similarity protocol. This is what lets receipts group "same kind of decision" reproducibly, later, without embeddings.
- Boundary-crossing exports stay structural (spine + argument commitments + sidecar by explicit disclosure choice), validator-enforced.

**Gate:** re-run the customer-zero goal; the receipt reads end-to-end (human and agent); structural fields on 100% of consequential events; zero raw content in boundary exports.
**True reason to stop here:** none. Every reader class already demanded this for legibility alone.

### Step 2 — Close the credibility fixes *(already specced: CZ-1/2/3/8)*

Front door, run-type rule, seal semantics, packet self-containment. Not part of the reclaim — the precondition for anything facing anyone.

**Gate:** Part C acceptance criteria of the customer-zero review.

### Step 3 — The dual axis, made explicit

The second axis of every decision trace is **the environment's observed response**: what the runtime and the institution's own systems *did* next, witnessed by hooks as it happened. Typed as past-tense observations:

- `PROCEEDED` — the call was forwarded and returned
- `HELD` — the runtime raised its own approval prompt (a PermissionRequest event was observed)
- `TURNED_BACK` — the runtime or tool declined the action
- `GATE_STOPPED` — an external system's own rule halted forward motion (e.g., a required status check)
- `REDONE` — a later observed event superseded this one

**Vocabulary guard — constitutional for this step.** These are records of events Lyhna *witnessed*, never verbs Lyhna *performs*. Lyhna approves nothing, escalates nothing, refuses nothing, blocks nothing — it has no part in the response axis except seeing it and writing it down, exactly as it has no part in the agent's claim axis except recording it. Every response label must trace to an observed external event (hook event ref on the receipt); if any label is ever computed from Lyhna's own decision rather than an observed event, that is bind returning through a field name — stop that change. The permission-flavored words (approve/escalate/refuse/block) are banned from this axis's schema and surfaces; the project has already lost 60–90 days to that vocabulary once, and it rode in through exactly this kind of naming.

The Rooms run showed the data already flows (three external gate stops observed and recorded); this step only types what is already seen.

**Gate:** a blind reader can reconstruct "what the environment did in response" from the receipt without prose — and cannot mistake any of it for something Lyhna decided.

### Step 4 — The corpus: runs become a population

Local receipt inbox/index across runs (the witness capsule-indexer already exists) plus deterministic cross-run grouping by structural identity. No scoring yet — just: the graph exists and is queryable. *"Show me every deploy-shaped decision across the last 30 runs."*

**Gate (G2-flavored):** the operator or the operator's agents actually query it weekly. If nobody reads the corpus, pause before Step 5 and find out why.

### Step 5 — The reducer, rehydrated *(read-only measurement)*

Point the 6/7 brain at the corpus. Deterministic, offline, no model calls, no clock — the same discipline as the labeler:
- **Consistency** — same decision shape, same response, across runs?
- **Determinism** — or coin-flips?
- **Escalation stability** — steady, or spiking?
- **Drift** — localized to one domain, or spreading?
- **Health grade** per decision domain — Fragile / Developing / Stable / Robust.

**Gate:** the metrics change a real decision (a domain gets automated, or de-automated, because of the read) — the "did it change a decision" test, at corpus level.
**Hard kill-guard:** the moment any score is used to *block* execution, stop that move — that is bind reborn with better branding. Grade, trend, notify. Never gate.

### Step 6 — The two readers, productized

- **Agent-reader:** the verified continuation. Loading the prior receipt through the witnessed read tool becomes the first act of every new run — continuation itself joins the witnessed record. (Part F showed this working unprompted: the builder read its own receipt and revised its next-run process.)
- **Human-reader:** import Lighthouse's *presentation* discipline onto the report layer — decompose every composite verdict into named, weighted factors with "what's driving it, what would move it." Never import its re-derivable capture model.

**Gate (G3-flavored):** a receipt or health-read is voluntarily shown to someone else; next-run behavior measurably improves (earlier witnessing, fewer redundant re-audits).

### Step 7 — Decision Observability / the Agent-Readiness Map *(the outward product)*

The Kinetic Context Layer wedge, shipped: per-domain judgment-health trending; an automation-readiness read (*"in this kind of decision, how stable have outcomes been?"*); portable, signed health nodes; Tier 1 countersigning the day any read faces a third party.

**Gate:** G4 — someone who isn't Adam pays. Thesis v2's kill criterion applies at this level: if the human-facing observability surface fails its gates, the corpus and the agent-reader remain the product — the engine pivots its reader, not its existence.

## 3. The direct answer: is there a true reason to stop at Step 4 instead of Step 7?

**No.** The legitimate stopping conditions are not step numbers:

1. **A gate fails twice** — the market is saying no to that rung's *reader*, so pivot the reader within the same engine (Thesis v2's own kill logic). That redirects the ladder; it doesn't shorten it.
2. **The honesty ceiling would have to break** — never a valid trade. No rung above requires it; Step 5's kill-guard exists precisely to keep it.
3. **Measurement starts gating** — stop *that move*, not the ladder.

Thesis v2 stopped where it did because of evidence available in a pre-hook world and solo-founder bandwidth — circumstance, not principle. Both constraints have changed. The ladder is sequenced by dependency, not by ambition; nothing in the record argues for less than Step 7, and the January theory plus the June recovery plus this week's field evidence argue *for* it from three different directions.

## 4. What stays retired (so the reclaim doesn't reopen old wounds)

- **Authority/bind as headline or identity.** Scope-check remains one field in the record. The yes/no click is plumbing.
- **Gating of any kind above the existing fail-closed capture mechanics.** The reducer never blocks.
- **Semantic goal-drift judgment** — the "check-5 trap" from the Recovery Record: "serves the objective" requires modeling intent. Structural facts about the ledger only.
- **Second-brain / memory-store framing.** Re-derivable content stores are the crowd, architecturally pointed away from sealed-at-the-event capture. Feed graphs; own the judgment graph.
- **Authoring competing receipt schemas; leading with "signed receipts."** (Thesis v2 §15, unchanged.)

## 5. One-line reminder

The honesty ceiling was never the limit — it's the moat. The blindfold was a different decision, made for a product that no longer exists. Capture everything. Certify nothing. Grade the record, never the right to act.

*The builder produces. The evaluator examines. Lyhna witnesses. The corpus grades. Adam decides.*
