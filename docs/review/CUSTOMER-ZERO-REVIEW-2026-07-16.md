# Customer-Zero Review — Live Run Findings and Next-Slice Work Order

> **Provenance.** Written 2026-07-16 by the independent third-party evaluator session (Claude), after Adam ran the first real customer-zero loop: a reviewed build goal in ChatGPT Work (Codex) against the Homestead repos, with the installed lyhna-codex-adapter recording. Evidence: the Codex thread transcript, the Sources/Subagents pane, two sealed Lyhna runs (`run_dd5eb74c…` retrospective `pr_only`, `run_baacc437…` `full`), and code inspection of PR #1 head `013c70f` in this repository.
>
> **Role boundary.** The builder produces. The evaluator examines. Lyhna witnesses. Adam decides. This document reports findings and a recommended work order; it approves, certifies, and merges nothing.
>
> **Companions:** `THESIS-V2.md` (draft canonical thesis, pending Adam's adoption), `LYHNA-REVIEW-DOSSIER.md` (full evidence record behind Thesis v2, including the 2026-07-15 PR #1 evaluation and three adversarial reviews).

---

## PART A — UPDATED VERDICT: WHAT CUSTOMER-ZERO CHANGED

The 2026-07-15 opinion was: *worth continuing, but only as a repositioned product*, with the decisive question deliberately deferred to this run — **"did the receipt change any decision Adam made?"**

The customer-zero run answered it, and the answer upgrades the verdict — with one important refinement about where the value actually lives.

### A1. The open question is answered: the loop earns its keep

An independent evaluator child found a real defect the builder had missed — the PR #121 older-revision tampering gap. The builder corrected it, added a fail-closed regression test, moved the head (`cb209…` → `345deb…`), and re-ran both hosted and independent review. That is a material, evidence-attributed correction produced by the witnessed evaluation loop on its first real outing. The 2026-07-15 worry that honest-but-weak evidence might be "informationally thin" is resolved for the loop: the loop demonstrably improved the build.

**The refinement:** the value showed up in the *loop*, not in the receipt as a read artifact. The readable conclusions ("one B09 correctness finding," "no blocking findings") lived in Codex's ephemeral Subagents pane; the durable receipt retains them only as hashes and word counts. The thread UI is readable but ephemeral; the receipt is durable but opaque. Bridging that split (Part B, CZ-5) is now a product requirement, not polish.

### A2. The authority boundary held under real conditions

Across three consecutive turns, B09 was blocked by Homestead's own `capture-v1/live` ruleset — a gate Lyhna recorded and never became. No merge, no deploy, no Lyhna-as-authority. The honesty boundary is not just copy; it survived contact with a real multi-repo, real-stakes loop.

### A3. The org pattern appeared again — and the sequencing rule caught it

The known failure shape (immaculate internals, unproven live edge) recurred exactly once more: the front door. The witnessed smoke exercised `$lyhna`, the documented trigger; the real product surface turned out to be a mid-message `@lyhna-codex-adapter` plugin mention, which the matcher cannot recognize (CZ-1). Testing matched the spec, not the user. The difference this time: the live run caught it **on day one, in the field**, which is Thesis v2 §14 working as designed. This is also the strongest installed-runtime registration evidence to date — ten tools callable, 487 events, two sealed verifier-clean runs in the real ChatGPT Work runtime.

### A4. "Can this become something?" — the honest answer

Yes — and the evidence base for "yes" is now materially stronger than it was on 2026-07-15:

- The one demo no shipped competitor can run (independent evaluation of an agent's work, witnessed, sealed, with a real catch and a real authority-gate stop) **has now actually happened**, on real infrastructure, with reconciling counts.
- The founder-as-customer-zero is squarely the Thesis v2 §9 primary ICP (technical operator running coding agents unattended), and the pain and the value both showed up in week one. That is n=1, and it is the founder — it validates the product mechanism, not the market. The market gates (G1–G4) are unchanged and still decide.
- The field evidence *strengthened* two Thesis v2 positions: capture-is-scaffolding / no-dashboard (§13 — "Codex already has the cockpit"; Lyhna's job is to be legible inside it and durable outside it), and Fork D leaning toward the adapter as the coding-agents capture vertical rather than a parked experiment.
- One evidentiary note for the recorded Plan B (agent-readable verified continuation): the durable-vs-readable split observed in this run is consistent with the possibility that the retained-value reader is the next agent/session rather than a human. No pivot is warranted — but the kill-gate framing gained credibility and should be measured honestly when G2 is read.

**Conditions unchanged:** the credibility-bearing fixes below (CZ-1 through CZ-3) join the §7 labeler hardening as marketing-blocking. Distance to product = these fixes + the live signed loop + the 10-minute stranger path + someone who isn't Adam paying.

---

## PART B — CODE-LOCATED FINDINGS FROM THE LIVE RUN

Severity is for the next slice, given the product's own claims. File:line references are at PR #1 head `013c70f`.

### CZ-1 — P0 — The front door fails on the real invocation form (two distinct mechanisms)

**Where:** `plugins/lyhna/src/store.mjs:396-409` (`rememberInvocation`).

**What happened:** Adam's goal began "Great job , thank you." followed by `@lyhna-codex-adapter Please move forward…`. Both sealed runs recorded `objective_origin: agent_reported`; the first ~26 minutes of build work and its subagents fell outside the witnessed record entirely (the `full` run began only at the later correction loop).

**Mechanism 1 — position.** The matcher is anchored to the start of the prompt (`^` after `trimStart`). Any preamble text defeats the front door regardless of what follows.

**Mechanism 2 — form.** The literal branch `/^(?:@lyhna|\$lyhna)(?=$|[\s,:;.!?])/i` requires whitespace/punctuation/end after `@lyhna`; a hyphen fails the lookahead, so the plugin's actual full name `@lyhna-codex-adapter` — the form Codex's UI naturally produces — can never match. The structured branch expects exactly `[@lyhna](plugin://lyhna-codex-adapter@lyhna-ai)`, a guessed serialization that evidently did not hold either.

**Design insight for the fix:** the pending file written by `rememberInvocation` only *upgrades attribution* — `beginRun` reads it to set `runtime_hook` vs `agent_reported`; it never starts a run by itself. A false-positive match is therefore nearly free, while a false negative just cost half the witnessed record. The asymmetry argues for a permissive matcher.

**Smallest correction, in order:**
1. **Instrument first.** Capture the raw `UserPromptSubmit` payload for a real `@lyhna-codex-adapter` mention in the installed runtime before writing any new regex — do not guess at Codex's serialization a second time.
2. Match the mention token anywhere in the prompt (word-boundary, not `^`-anchored), accepting `@lyhna`, `$lyhna`, `@lyhna-codex-adapter`, and whatever structured form step 1 reveals.
3. Regression-test with realistic prompts: preamble text before the mention, mention mid-sentence, long-form name.

### CZ-2 — P1 — Run-type selection defaulted to retrospective for a build goal

**What happened:** the goal explicitly said "move forward with this plan… build… use subagents" — an active build instruction — yet the first run created was retrospective `pr_only`. The `full` run only began at the second segment.

**Smallest correction:** encode the selection rule in the skill and tool descriptions: **`full` whenever the request asks to build, change, continue, or delegate; `pr_only` only for explicit retrospective examination of an existing PR.** If ambiguity remains at runtime, prefer `full` — a full run that observes little is honest; a retrospective run covering active build work misattributes the whole session.

### CZ-3 — P1 — Seal semantics: no enforced final refresh; superseded heads presented as CONSISTENT

**What happened:** the retrospective run sealed without refreshing the PR after evaluation — it proves the evaluated head, not that the head was still current at closeout. Separately, PR #121 and Keep #71 each changed heads mid-run; Lyhna correctly evaluated both revisions of each, but the receipt presents both as CONSISTENT with no distinction between the final head and its predecessors. Each per-head statement is individually true; the run-level presentation could mislead a reader into thinking both reviews describe the final PR. (Close currently requires a retrieved, non-stale evaluator receipt per CONSISTENT snapshot — but "non-stale" is receipt-vs-snapshot, not head-vs-remote-now.)

**Smallest correction:**
1. Require a post-evaluation `refresh_pr` per covered PR before seal, **or** stamp the receipt `NOT_REFRESHED` on its face. A sealed receipt must never imply currency it did not check.
2. Add run-level per-PR chain labels: `CURRENT` / `SUPERSEDED` / `STALE` / `NOT_REFRESHED`, with one compact card per PR showing the head chain.

This is the gauntlet lesson operating again: honesty bugs live in the prose and the verdict semantics, not the label sets.

### CZ-4 — P2 — Coverage boundary absent from the receipt narrative

**What happened:** the `full` run contains five evaluator children and no ordinary delegated-child receipts — because the first segment's builder subagents ran before any run existed (`recordHookForParent`, `store.mjs:423-431`, attaches hook events only to an active run; with none, it no-ops). The receipt is silent about this, so absence reads as "none occurred" rather than "not yet observing."

**Smallest correction:** every receipt states its temporal coverage boundary plainly: *"Witnessing began at T (N minutes after the goal was issued); M prior subagents were not observed"* and, where applicable, *"No ordinary delegated-child lifecycle observed."* This is the Thesis v2 §6 coverage manifest, extended with the time dimension the live run showed matters.

### CZ-5 — P2 — Durable-but-opaque vs readable-but-ephemeral

**What happened:** the receipts prove that evaluators recorded findings, but retain the findings only by hash and word count; the readable conclusions lived in Codex's ephemeral UI panes.

**Smallest correction:** a **local-private readable sidecar** (claim and evaluator-finding summaries in plaintext), hash-referenced from the sealed receipt — the same two-projection pattern the proxy already uses for scope capsules (structural projection in the sealed record, plaintext sidecar outside it). Durable record stays structural-only; legibility stops being hostage to the host UI.

### CZ-6 — P2 — Sensitive-output events cross the tool boundary invisibly

**What happened:** during the run, the builder printed the container's full environment (secret-bearing values) into the thread, disclosed it itself, and recommended credential rotation. Lyhna correctly persisted none of the values — but neither sealed receipt contains any indication that sensitive output crossed the boundary. Had the builder omitted its disclosure, the incident would be invisible in the durable record.

**Smallest correction:** a value-free observation event: *"Sensitive-output pattern observed in returned tool output. Values not retained. Credential review recommended."* Two hard guardrails: (a) it is a best-effort heuristic and the receipt must say so — **absence of the flag means nothing** (otherwise the receipt quietly becomes a security clearance, violating the honesty ceiling); (b) record only the pattern family and event reference — never enough to reconstruct the value.

*(Operational note, outside the adapter's scope: the rotation of the affected credentials is the operator's action and, as of this writing, remains recommended and not performed.)*

### CZ-7 — P3 — Surface polish, pointed the right way

Format tool responses as compact run cards for Codex's Sources pane (group by run, one card per PR/head, SUPERSEDED marked) rather than large JSON objects; consider an opaque checkout handle in place of the visible checkout path (consistent with the existing `cwd_ref`/`checkout_path_ref` hashing discipline); return the receipt link at closeout.

---

## PART C — RECOMMENDED WORK ORDER FOR THE NEXT SLICE

Dependency-ordered; items 1–2 are credibility-bearing and block any marketing motion, same rule as the Thesis v2 §7 labeler hardening.

1. **Front door (CZ-1):** instrument the real mention serialization → permissive matcher → regression tests with realistic prompts. Plus the run-type rule (CZ-2).
2. **Seal semantics (CZ-3 + CZ-4):** enforced final refresh or `NOT_REFRESHED` stamp; `CURRENT`/`SUPERSEDED` chain labels; temporal coverage boundary on every receipt.
3. **Readable sidecar (CZ-5):** hash-bound local plaintext summaries.
4. **Sensitive-output observation (CZ-6):** value-free, heuristic-labeled, absence-means-nothing.
5. **Sources-pane run cards and opaque checkout handles (CZ-7).**

Acceptance for the slice: rerun the same class of goal (preamble + `@lyhna-codex-adapter` mention, active build instruction) and verify — front door binds as `runtime_hook` from message one; run type is `full`; every covered PR shows a head chain with exactly one `CURRENT`; the receipt names its temporal coverage; the sidecar renders the evaluator findings readably; all existing tests and the validator stay green.

## PART D — WHAT THE RUN PROVED (EVIDENCE RECORD)

- Two runs, both sealed, both passing the integrity verifier: `run_dd5eb74c…` (retrospective `pr_only`), `run_baacc437…` (`full`).
- Full run: 487 events — 112 returned shell actions, six patch operations, five evaluator spawns, five evaluator findings. Six PR snapshots ↔ six independent evaluations ↔ six retrieved evaluator receipts: counts reconcile.
- Coverage: infra PR #120 (one head), infra PR #121 (two heads), Keep PR #71 (two heads).
- Real catch: evaluator found the PR #121 older-revision tampering gap → fix + fail-closed regression test → head moved `cb209…` → `345deb…` → re-reviewed clean.
- Authority boundary held: three consecutive turns blocked on the host's own `capture-v1/live` ruleset; Lyhna recorded, never gated; no merge or deployment occurred.
- Installed-runtime registration confirmed in ChatGPT Work: the decisive check the 2026-07-15 evaluation said no local validator could provide has now effectively run in production form.

## PART E — THESIS V2 DELTAS PROPOSED BY THIS RUN

Small, additive; adoption is Adam's decision along with Thesis v2 itself:

- **§7 (marketing-blocking hardening):** add CZ-1/CZ-2/CZ-3 (front door, run-type rule, seal semantics) to the list for the Codex adapter surface.
- **§6 (coverage manifest):** extend with the temporal boundary — receipts state when witnessing began relative to the goal.
- **§13 (adoption):** field-validated — the host already owns the cockpit; Lyhna outputs shape themselves to the host's panes and stay durable underneath.
- **Fork D (adapter's role):** evidence now favors the "coding-agents capture vertical" branch over "park after customer-zero" — the adapter produced the project's first field-proven value.

---

## PART F — POST-SCRIPT: THE BUILDER READS ITS OWN RECEIPT (2026-07-16)

After this review was drafted, Adam asked the Codex builder agent (in the Rooms thread) to read the sealed Lyhna receipts from its own Sources pane and reflect on its build. The result is the strongest single piece of product evidence in the record:

1. **The consumption loop closed.** The sealed receipt was read back by the agent that produced the work, and it changed that agent's plan for the next build (start witnessing before the first consequential edit; manage PR heads as a structural head/review matrix; keep evidence classes distinct; stop once at a proven authority gate). This is the *agent-readable verified continuation* — Thesis v2's recorded Plan B — functioning in the wild before it was built as a product. Taken with CZ-5, the reader hierarchy in the field evidence is: **agent first, human as auditor of exceptions.** This does not trigger the pivot criterion (the gates are unmeasured), but Plan B should be treated as a live co-primary hypothesis, not a fallback.
2. **Independent convergence.** Reading only the receipts — not this review — the builder arrived at the same leading findings (witnessing began too late = CZ-1; head-chain bookkeeping should be structural = CZ-3; the gate loop was honest but noisy). The outside witness and the builder's self-reflection reconciled from opposite sides of the same record.
3. **The honesty ceiling held its shape in miniature.** The builder's "yes, I can read it" is itself an unwitnessed agent-reported claim — and one of its two quoted receipt links carried a transposed run id. Sincere self-reports remain unreliable in the details; that is the product's founding premise restating itself. The adapter already contains the remedy: receipt reads through `read_sealed_receipt` are witnessed, so *loading the prior receipt through the tool as the first act of a new run* makes continuation itself part of the witnessed record. Recommended as a skill-level instruction in the next slice.
4. **Two builder-side norms worth preserving (outside Lyhna's scope):** pre-declared diagnostic field whitelists — never inspecting complete environments — as the builder-side complement to CZ-6; and a single crisp `NEEDS_DECISION` stop at a proven authority gate instead of repeated re-audits — which the adapter could support by allowing a run to cite the prior sealed gate observation rather than re-proving it.

---

## PART G — THE BLIND-READER TEST (2026-07-16)

Adam handed the exported run material to two third-party agents with **no knowledge of the Lyhna adapter or witness** and asked them to audit it cold. This is the witness THESIS moat line — *"the demo survives 'have your own AI audit this receipt'"* — run as a live experiment, twice.

### G-1. Result: legibility debt, not honesty debt

Both blind readers landed independently on exactly the product's claimed boundary: the material proves PR snapshots and clean, detached, exact-head evaluator checkouts — not build completion, finding substance, review-comment resolution, merge, deployment, or acceptance. Neither reader over-credited anything; neither dismissed the material as noise — both extracted real value (exact heads per PR, checkout integrity before/after, then-current check states, run and lifecycle counts, `agent_reported` origins correctly discounted). Every correction they proposed is a legibility or packaging fix; no honesty violation was found. Also notable: all readers of these receipts to date — evaluator, builder, two blind auditors, and this reviewer — are AIs, reinforcing Part F's reader-hierarchy observation.

### G-2. New findings from the blind read

**CZ-8 — P1 — The exported packet does not prove its own seal.** Both readers independently refused to credit sealing: close requests are visible, but no seal result, parent sealed-receipt ID, or verifier-checkable anchor appears in the packet. (The runs did seal and pass the integrity verifier — this is packaging, not integrity — but for a portable proof object the packet *is* the product, and a proof object that cannot demonstrate its own seal fails for a cold reader.) One reader also caught an internal inconsistency: grouped child lists marked `retrieved: false` alongside six receipt-read events, making closeout order unreconstructable. **Fix:** the exported packet is self-contained — seal status and anchor, parent receipt ID, per-child retrieval status at closeout, chronological ordering. This joins the credibility-bearing tier alongside CZ-1/CZ-3.

**CZ-9 — P2 — The semantic ladder is implicit where it must be explicit.** "Workflow check succeeded" ≠ "evaluator found no blocking issue" ≠ "findings were fixed" ≠ "accepted." The packet currently supports only the first at selected heads, and says nothing to stop a hurried reader from climbing the ladder unaided (e.g., a check-run *named* "Claude Code Review: SUCCESS" is not "approved" or "comments resolved"). **Fix:** the receipt renders these as distinct labeled statements and asserts only the rungs it supports — the gauntlet lesson ("honesty bugs live in verdict semantics"), restated verbatim by a stranger.

**CZ-10 — P2 — Runs and evaluations don't explain themselves.** The objective text is entirely absent from the packet (a stranger cannot tell what the run was for), and PR #120 was evaluated twice at the identical head with no scope distinction. **Fix:** include the sanitized objective synopsis in the packet, and record each evaluation's trigger/scope (initial, post-fix re-evaluation, separate-run gate audit) so duplicate exact-head evaluations are self-explaining.

### G-3. Convergence across all reader classes

The readable evaluator verdict (CZ-5) is now independently demanded by every class of reader: the builder, both blind auditors, and this review. It is the single most-requested fix in the record. The blind readers also re-surfaced, without prompting: the `agent_reported` origin on both runs (CZ-1 visible to a stranger), the evaluator-children-only coverage question (CZ-4), and superseded-head ambiguity (CZ-3).

**Amendment to Part C:** the work order's credibility-bearing tier is now items 1–2 **plus CZ-8** (packet self-containment); CZ-9 and CZ-10 fold into step 2's seal/receipt-semantics work.

---

*The builder produces. The evaluator examines. Lyhna witnesses. Adam decides.*
