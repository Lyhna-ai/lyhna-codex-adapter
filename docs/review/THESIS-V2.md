# Lyhna — Product Thesis v2 (ADOPTED)

> **ADOPTION RECORD — 2026-07-25.** Adam ratified this thesis. It supersedes `THESIS.md` (2026-06-13) and is now canonical. The body below §1 is preserved verbatim as the adoption terms require; nothing in it was edited, softened, or "improved." Two amendments are recorded below, both driven by evidence found after 2026-07-15 — neither reverses a v2 position.
>
> **Amendment A — the continuation lane is a first-class surface, not a receipt field.**
> §4 named `HANDOFF.md` / `handoff.json` / the continuation object as surfaces of the trust-labeled receipt. Evidence since: the failure that actually costs users is not a bad receipt, it is a **bad handoff between context windows**. A window ends when it becomes expensive, the outgoing agent writes its own summary, and drift compounds window over window until the thread is no longer describing the same project — with no way for a non-engineer to detect it. So the continuation capsule and its **cross-window lineage check** are promoted to a named product surface in their own right. Corollary, now constitutional: *the agent does not write its own report card.* The handoff is folded from the ledger by the supervisor path, and whether window N+1 truly inherited window N is a **mechanically verifiable question**, not a judgment call. Shipped in `lyhna-codex-adapter` 0.1.28.
>
> **Amendment B — Verified Context is the default; content-blindness is an export projection, not a storage policy.**
> The adapter stored builder claims content-blind, reducing an agent's own assertion — to its own owner, about that owner's work, on that owner's machine — to a word count. That is reversed. A claimed-vs-actual product that will not show you the claim has discarded the half of the diff only a human can judge, and there is no third party whose privacy was being served. Claim text is now **retained**, with secrets scrubbed and length bounded. Withholding became `privacy_mode: proof`, a projection applied when a packet **leaves** the machine, fixed at run start and sealed into the chain so rendering stays deterministic. What is *not* reversed: secrets, credentials, environment values, full tool output, and full command output remain unstored — those protect the owner when a packet is shared, rather than protecting anything from the owner. Shipped in `lyhna-codex-adapter` 0.1.29.

## Original draft header (preserved)

# Lyhna — Product Thesis v2 (DRAFT FOR ADAM'S DECISION)

> **Provenance.** Drafted 2026-07-15 by the independent third-party evaluator session, at Adam's direction, after: (a) an evidence-bound review of `lyhna-codex-adapter` PR #1; (b) strategy-grade maps of `lyhna-witness` and `lyhna-mcp-proxy`; (c) three independent adversarial reviews of a draft thesis — buyer/GTM, platform/competition, and technical evidence-value (the last grounded in the actual code, with file:line citations); (d) market verification with sources. The full evidence record is `LYHNA-REVIEW-DOSSIER.md` (companion file).
>
> **Status.** This document supersedes `THESIS.md` (2026-06-13) **only if Adam adopts it**. Until then, the 2026-06-13 thesis remains canonical. If adopted, preserve verbatim; do not edit, soften, or "improve." The build layer serves this thesis and never overrides it. Every change from v1 is listed in §18 with the evidence that forced it — nothing here was changed on taste.

**Date:** 2026-07-15
**Purpose:** Preserve the strategic decision so future AI/human sessions can continue without re-litigating architecture, market, and product questions.

---

## 1. Current Decision

Lyhna is **not** the receipt layer. Receipts — capture, signing, portable offline verification — are becoming free, standardized infrastructure: an open-source competitor already ships mediator-keyed signed action receipts with broader capture than ours; Microsoft, an IETF draft, and the MCP roadmap itself are standardizing the layer below us.

The product direction is:

**Lyhna is the verification layer above agent receipts: the deterministic reconciliation engine that diffs what an agent *claimed* against what was independently *witnessed* — from Lyhna's own capture today, and from any standard receipt format as those land — and gives the human a trust-labeled verdict and a safe continuation.**

- The diff engine and its trust labels are the product.
- Capture surfaces (MCP proxy, Codex adapter, future collectors) are scaffolding: valuable, replaceable, and declared as such — out loud, including to buyers.
- The receipt inbox is the retention surface.
- Independent countersigning is the revenue service.

The product value is not "here is a signed log." The product value is:

*Everyone else attests the traffic. Nobody audits the narrative. Someone has to read the agent's story against the record — Lyhna is the reader.*

## 2. Why This Matters

Unchanged from v1 in substance: the agent is usually the only narrator of what it did in real systems, and that narrator is unreliable — not malicious, but unreliable. Agents report intent rather than actual path; they say "sent" when the witness saw a draft; they say "done" when steps were skipped, refused, or completed through a fallback.

What changed since June: the category became visible. Multiple shipped products and standards drafts now attest agent **traffic** (signed action receipts, attestation gateways, protocol-level audit trails). **None of them parse the agent's claims. None of them can run our Gmail draft-vs-send demo.** The June thesis named the primitive — *claimed vs. actual* — before the category had a name. That primitive is still the empty square on the board, and it sits one layer above everything that is being commoditized.

## 3. Core Product Sentence

Use this until a named delta changes it:

**Lyhna reads your agent's story against the record: it diffs what the agent claimed against what was independently witnessed, labels what you can trust, and hands the next human or AI a safe continuation.**

Shorter versions:

- The agent's story, checked against the record.
- Claims, tested.
- Know what to trust.

Avoid leading with: "signed receipts" (commodity — someone else's shipped headline), "proof of what your agent did" (overclaim; see §6), "independent witness" as a principle (sell the conflict-of-interest mechanic instead: *the agent's vendor has no incentive to flag its own agent's confabulations to you*), authority/gating, governance, memory.

## 4. Settled Product Model

**Form.** One monorepo. One published package (the two-repo, git-clone-only topology is retired — every tester hit it). One desktop inbox app. The engine consumes witness input from **any** capture source: our own proxy, our own host adapters, and standard receipt formats (Pipelock / AGT / ACTA / MCP-native) as they converge. **Adopt formats; never author a competing schema.**

**Surface.** The trust-labeled receipt (HANDOFF.md / handoff.json / next-ai-prompt.md), the local receipt inbox, and the continuation object.

**Hidden spine.** Deterministic labels (no clock, no randomness, no model calls; identical input ⇒ byte-identical output); the honesty ceiling; and — new, constitutional — a **coverage manifest** and a **claims-tested denominator** on every receipt (§6, §7).

## 5. The Key Difference From the Receipt Category

A shipped receipt product proves *traffic*: this call crossed this boundary, signed, hash-chained. A Lyhna verdict tests *testimony*: here is what the agent said, here is what was witnessed, here is where those agree, and here is every claim that has nothing behind it.

Traffic without narrative cannot tell you the agent lied about what the traffic was. That is also the difference from observability (LangSmith/Langfuse/Arize): their trace **is** the agent's self-report.

## 6. V1 Promise and the Trust Ladder

The honesty ceiling stands and is hardened into three explicit assurance tiers. **Every receipt states its own tier on its face.**

- **Tier 0 — local, uncountersigned.** Tamper-evident against post-hoc edits by anyone below root **on this machine**. Internal evidence only. The receipt says exactly this. It is never presented as proof to a third party — the machine owner is precisely the party a third party would need protection from.
- **Tier 1 — hosted countersignature + trusted timestamp.** An independent Lyhna service co-signs the receipt hash, a trusted time, and the tenant identity (transparency-log entry so receipts cannot be backdated or silently re-issued). This is what makes a receipt credible to anyone other than the operator. **It ships the day the first receipt is shown to a third party — it is the product's claim to exist for that use, not a premium afterthought.**
- **Tier 2 — argument commitments.** Salted hashes of load-bearing arguments (recipient, amount, target id) pinned into the receipt, so "right recipient / right amount" is answerable without publishing contents. Without Tier 2, Lyhna attests that *a call of this shape ran and returned* — never what it contained. First premium capability.

V1 must not claim: "proof of what your agent did"; universal coverage (**"Lyhna witnesses what you route through it"** is the whole truth, and the receipt names what it did not see); catching every lie (§7); real-world outcomes; work correctness. Unchanged constitutional line: *Lyhna witnesses what crossed the boundary and compares it to claims. It does not magically know reality outside the observed path.*

New constitutional lines:

- **A receipt never renders green for an unclaimed or unread call.**
- **Every receipt prints its coverage boundary and its claims-tested denominator** ("claims tested: 2 of 2; calls with no claim: 14; unwitnessed surfaces: shell, browser, direct API").
- A zero-claim run is branded **"activity log (no claims tested)"** — never a trust verdict.

## 7. The Labeler Hardening (settled V1 engineering; blocks all marketing)

The code-grounded adversarial review demonstrated that the current engine can be gamed by claim phrasing and defaults. These six fixes are **settled requirements**, not suggestions; file:line evidence is in the dossier (§6 of the technical review):

1. **`OBSERVED_UNCLAIMED` label.** A witnessed call with no claim never reads `SUPPORTED`; it does not count toward a green headline.
2. **Claims-tested denominator** in the top-line verdict of every receipt.
3. **Action-family reconciliation of free-text result verbs.** "Said *sent*, tool was *create_draft*" raises `CLAIMED_ACTUAL_MISMATCH` even when the claim omits the structured `action` field. A claim missing `action` on a witnessed consequential call fails closed (`NEEDS_EVIDENCE`), never sails to `SUPPORTED`.
4. **`user_facing` derived from witnessed tool identity** for outbound tool families (send/pay/post). Never agent-sourced. The agent cannot dodge `DO_NOT_SEND` by omission.
5. **Coverage manifest** on every receipt: which surfaces were witnessed; explicit statement that shell / browser / direct API were not.
6. **Wrapper app-cracking claims retired from all buyer surfaces** until argument-level capture exists. (The "said Google, saw Zapier→google_docs" crack does not fire in the production loop; only the coarse route mismatch does. Our own gauntlet says so.)

## 8. Agent-Facing Primitives and Labels

The v1 primitive list stands (`load_handoff`, `record_claim`, `record_evidence`, `record_decision`, `check_next_step`, `compare_claimed_vs_actual`, `flag_unsupported`, `mark_settled`, `mark_reopened`, `export_handoff`, `export_next_ai_prompt`). The label vocabulary stands, plus:

```
OBSERVED_UNCLAIMED
```

Every export (receipt, OKF, PAM, continuation) carries per-item `evidence_status` and the run-level coverage manifest, so downstream consumers inherit the honesty ceiling instead of stripping it.

## 9. Buyer (changed)

**Primary:** technical operators and boutique dev consultancies running coding/desktop agents unattended (Claude Code, Codex, local runtimes). They can install the capture path in minutes, they feel the pain weekly, and the Codex adapter is already aimed at them. The v1 non-goal "developer-only proof cards as the company" was protecting us from a market that cannot currently receive the product; the *reachable* buyer is technical, and the expansion path runs through them.

**Second (requires Tier 1):** consultancies that show receipts to their clients. Countersigning is what they are paying for — that is the subscription.

**Explicitly gated — do not sell until hosted-platform capture exists** (a Zapier middleware app, an n8n node, a webhook relay): marketing agencies and non-technical operators. Their agent traffic executes in someone else's cloud and never transits a local proxy; they check the sent folder for free; and a granular record of agent activity is margin-transparency and discoverable liability they are rationally disinclined to create. The sentence "a non-technical operator installs a local MCP proxy" must not appear in any plan.

**Deferred:** enterprise compliance. EU AI Act Article 12 binds providers of high-risk systems — not this ICP — and is dropped from the pitch. The deployer-obligations (Article 26) angle belongs to a future enterprise motion only.

## 10. Retention and the Wedge (changed)

**Sell "stop checking," not "catch liars."** The retention product is the always-on artifact and the inbox — *"Run your agents. Walk away. Come back to receipts."* The catch rate at small-operator scale will not sustain weekly drama, and a smoke detector that never fires stops being valued.

The `DO_NOT_SEND` draft-vs-send catch is **the demo and the marketing moment** — the one demo no shipped competitor can run, because none of them parse claims. It is not the retention loop.

Success metric: **the operator opens the receipt inbox 3+ times/week by week 4** — not catches per week.

## 11. HOLD (bounded)

Every major platform ships native human-in-the-loop approval. Do not compete head-on, and do not reopen authority as the headline. The only permitted shape: an **opt-in, cross-platform approval inbox bound to receipts** ("held until witnessed"), with an explicit customer choice of fail-open vs. fail-closed and the liability of each spelled out in writing. Never the headline; never the pricing anchor. Enforcement inverts our failure mode from "no receipt" to "blocked the business" — if willingness-to-pay concentrates here, treat that as a signal to stop and reassess before becoming an approval company, which is a different and worse company to start.

## 12. Business Model (changed)

- **Consultancy tier: subscription.** Countersigning service, shared inbox, white-label-internal receipts, and the compatibility treadmill (MCP spec churn, host API churn — the Codex adapter has already been broken once by an upstream config change; that is the treadmill announcing itself).
- **Solo-operator tier: perpetual license + paid annual compatibility updates** (funnel).
- **Killed:** buy-once as *the* model (it cannot fund the treadmill this product structurally requires); metered pricing (stays killed); free-tier-as-main-frame (stays killed).

## 13. Adoption Thesis (changed)

The Datadog analogy is retired — it imported a conclusion without any of the mechanism. The bets that replace it:

1. **Be the best reader of everyone's receipts.** Join the MCP Enterprise WG and receipt-standard conversations now; aim to be the reference implementation of receipt *consumption*. A founder who helps shape the gateway-visibility extension gets a window as the default verifier.
2. **Capture as a portfolio, engine as the constant.** MCP proxy and Codex hooks today; hosted-platform collectors (Zapier/n8n), browser-session capture, and AP2 payment-mandate ingestion as funded milestones — all feeding one diff engine. The engine outlives every wire.
3. **The blind spot is the honesty feature.** Unwitnessed planes are labeled visibly (`OBSERVED_UNCLAIMED`, coverage manifest) rather than papered over. "We name what we didn't see" is the trust posture no platform selling its own agent will match.

## 14. Sequencing (dependency order; one live edge at a time)

The organization's repeated failure shape — three times across three repos — is immaculate internals with an unproven live edge. The sequencing rule is therefore: **close the live edge before adding anything.**

- **S1 (now):** Finish the Codex customer-zero slice (fix the plugin install boundary; complete one witnessed run with the child evaluator). Unify the repos into one monorepo; publish the packages.
- **S2:** The labeler hardening (§7). **Blocks all marketing.**
- **S3:** One receipt real end-to-end: signing exercised on live traffic (the Live-Bind Gate has been RED since June); then the stranger path — **a stranger goes from npx to a verified receipt on their own machine in ≤10 minutes, unaided.**
- **S4:** Ten design partners from the §9 primary ICP, founder pricing from day one. Tier 1 countersigning ships the day the first receipt faces a third party. Tier 2 argument commitments as the first premium capability.

**Gates (falsifiable):**
- **G1** — stranger to verified receipt ≤10 minutes, unaided.
- **G2** — inbox opened 3+ times/week by week 4 of a partner's use.
- **G3** — ≥3 of 10 partners voluntarily show a receipt to someone else within 60 days.
- **G4** — anyone renews or pays list price.

**Kill/pivot criterion:** two failed gates means the market is saying human-read receipts are read-never artifacts. Plan B uses the same engine with a different reader: the **agent-readable verified continuation** (`next-ai-prompt.md` / trust-marked handoff between agent sessions) becomes the primary product — evidence-bound memory for agent-to-agent handoff, which this codebase uniquely supports.

## 15. Non-Goals (updated)

All v1 non-goals stand: authority/gating/permission as headline; generic memory; generic transcript summarization; dashboard-first SaaS; storing raw customer content in the proof layer; claiming outcome or correctness truth.

Added:

- Authoring a competing receipt schema or standard.
- Leading with "signed receipts" or "proof of what your agent did" — anywhere, in any surface, including negation.
- The marketing-agency ICP before hosted-platform capture exists.
- Buy-once as the business model.
- Wrapper app-cracking claims before argument-level capture exists.
- Betting the company on the proxy: capture is scaffolding by declaration.

## 16. Open Forks (Adam decides; agents hard-stop and ask)

- **Fork A — countersign service: build vs. ride.** Build a minimal timestamp + Merkle transparency log, or ride existing infrastructure (Sigstore/Rekor-style). Decides S4 cost.
- **Fork B — HOLD in scope for v1 or deferred entirely.** §11 defines the only permitted shape if in scope.
- **Fork C — name/brand for the verification layer.** (v1 Fork 3, still open; still not urgent until the demo proves the pain.)
- **Fork D — the Codex adapter's role.** Recommended: it becomes the "coding agents" capture vertical of the same engine (its builder/evaluator capability separation is genuinely novel for dev-work receipts). Alternative: park it after customer-zero as a completed experiment.

## 17. Safe Continuation Prompt

> You are continuing Lyhna product work from Thesis v2 (2026-07-15).
>
> **Settled direction:** Lyhna is the verification layer above agent receipts — the deterministic engine that diffs agent claims against independently witnessed evidence and emits trust-labeled verdicts with a coverage manifest and a claims-tested denominator on every receipt. Receipts, capture, and signing are commodity infrastructure: adopt standard formats (Pipelock/AGT/ACTA/MCP-native), never author a competing one. Capture surfaces (MCP proxy, Codex adapter) are scaffolding and are described as such. Primary buyer: technical operators and dev consultancies running coding/desktop agents unattended. Third-party-facing receipts require hosted countersignature + trusted timestamp (Tier 1); local-key receipts are internal-only and say so on their face (Tier 0).
>
> **Do not re-litigate:** authority/gating as headline; buy-once as the model; the marketing-agency ICP before hosted-platform capture; receipt-schema authorship; "signed receipts" or "proof of what your agent did" as headline phrasing; wrapper app-cracking claims before argument capture.
>
> **Build order:** finish Codex customer-zero → labeler hardening (OBSERVED_UNCLAIMED; claims denominator; action-family result-verb mismatch; tool-derived user_facing; coverage manifest; retire wrapper-crack claims) → live signed loop + 10-minute stranger path → ten design partners + countersigning.
>
> **Honesty ceiling (unchanged and hardened):** action-level witnessed truth only; Lyhna witnesses what you route through it and names what it did not see; a receipt never renders green for an unclaimed or unread call; a zero-claim run is an activity log, not a verdict.

## 18. Change Register vs. Thesis v1 (with forcing evidence)

| # | v1 position (2026-06-13) | v2 change | Forcing evidence (full citations in dossier) |
|---|---|---|---|
| 1 | "The MCP adapter is the witness"; witness-in-the-path as the product | Diff engine as the product; capture is declared scaffolding | Pipelock ships free OSS mediator-keyed signed receipts; Microsoft AGT receipt proposal in interop testing; IETF signed-receipts drafts; MCP roadmap names audit trails + gateway patterns as priorities |
| 2 | ICP drifting toward agencies white-labeling client receipts (LLM-CONTEXT) | Primary ICP = technical operators/dev consultancies; agencies gated on hosted capture | Local proxy cannot see hosted-platform traffic; sent-folder workaround is free; granular records are margin-transparency + discoverable liability for that buyer |
| 3 | Hosted bind deferred; local signing planned as the "trust model fix" | Trust ladder: Tier 0 internal-only; Tier 1 countersign+timestamp required for any third-party audience, in v1 | A local key on the operator's machine is self-attestation to any third party; the signed turn core has no timestamp at all (judgment-ledger.ts) |
| 4 | "Claimed vs. actual" presented as a working guarantee | Guarantee holds only after §7 hardening | Code-verified bypasses: lie in free-text `result` with `action` omitted → SUPPORTED; silent agent → all-green; `user_facing` agent-sourced (labels.mjs, witnessed-event.mjs, record-claim-tool.ts) |
| 5 | Buy-once local desktop as the model | Subscription consultancy tier + perpetual-with-updates funnel | Treadmill economics: MCP/host churn is unpaid maintenance against collected revenue; Codex adapter already broken once by upstream change |
| 6 | Datadog-pattern adoption analogy | Reader-of-receipts + capture-portfolio + blind-spot-as-honesty | Analogy lacked every mechanism (breadth, workflow lock-in, recurring economics); MCP path carries a minority of consequential actions (AP2 payments, browser agents, hosted connectors route around it) |
| 7 | DO_NOT_SEND catch as the wedge and value | Artifact/inbox as retention; catch as demo/marketing | Smoke-detector decay: catch rate at ICP scale won't sustain weekly perceived value |
| 8 | (post-thesis drift) EU AI Act as tailwind | Dropped from pitch; Art. 26 deployer angle reserved for future enterprise | Art. 12 binds providers of high-risk (Annex III) systems — not this ICP |
| 9 | Morning dashboard downstream (v1 §11) | Unchanged, renamed: the inbox is the retention surface | Buyer adversary: "people pay to stop checking" |
| 10 | Wrapper app-cracking as marquee catch | Retired from buyer surfaces until argument capture | Reliability Gauntlet: the crack "does not fire in the production loop"; the signed pack discards the arguments it needs |

## 19. Decision Register (v2)

| Decision | Status | Reopen only if |
|---|---|---|
| Product is the claims-vs-actual verification layer; capture is scaffolding | Settled | A capture surface itself becomes the durable moat in practice (e.g., an exclusive wire nobody else can sit on) |
| Adopt receipt standards; never author one | Settled | Standards fragment for 18+ months and partners demand a Lyhna-authored interchange format |
| Primary ICP is technical operators / dev consultancies | Settled | Hosted-platform capture ships and agency-market pull is demonstrated with paid pilots |
| Tier 1 countersign required for any third-party-facing receipt | Settled | Never — this is a trust-model fact, not a market position |
| Labeler hardening (§7) precedes all marketing | Settled | Never — shipping before it is trust theater |
| Retention = artifact/inbox; catches = marketing | Settled | G2 passes while partners report catch-driven renewal reasons |
| HOLD is opt-in, bounded, never headline | Settled | Adam explicitly decides to build an approval company with eyes open |
| Subscription for consultancy tier; perpetual+updates funnel for solo | Settled | Funnel tier cannibalizes subscription in practice |
| Two failed gates → pivot to agent-readable continuation as primary | Settled | Gates redefined by Adam before measurement begins |

## 20. One-Line Reminder

The agent is an unreliable narrator. Receipts are becoming free. Someone still has to read the story against the record — **Lyhna is the reader.**

The builder produces. The evaluator examines. Lyhna witnesses. **Adam decides.**
