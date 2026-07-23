# LYHNA REVIEW DOSSIER — Evidence Record for Thesis v2

> **Provenance.** Assembled 2026-07-15 by the independent third-party evaluator session (Claude, remote cloud environment), at Adam's direction. Contents: (0) executive synthesis; (1) the PR #1 evaluation verdict; (2–3) strategy-grade maps of `lyhna-mcp-proxy` and `lyhna-witness` produced by exploration subagents with full repo access; (4–6) three independent adversarial reviews of a draft product thesis, produced by subagents instructed to steelman-then-break, with web research (A, B) and read-only code access (C); (7) the convergence table mapping attacks to Thesis v2 changes; (8) source index.
>
> **How to read this.** The subagent reports in Parts 2–6 are preserved substantially verbatim as the evidence record — including their severity ratings and their own "strongest surviving thesis" statements. `THESIS-V2.md` is the synthesis; this dossier is why each change was forced. Treat every claim here as citable evidence, not narration: Parts 2–3 cite file paths, Part 6 cites file:line, Parts 4–5 cite URLs.
>
> **Companion file:** `THESIS-V2.md` (draft canonical thesis, pending Adam's adoption).

---

## PART 0 — EXECUTIVE SYNTHESIS

**Verdict: worth continuing — but only as a repositioned product.**

Three independent adversaries (buyer/GTM, platform/competition, technical evidence-value) attacked the draft thesis from different angles and converged on the same conclusion from three directions:

**Receipts, capture, and signing are becoming free infrastructure. The layer nobody has built — and the one thing all three repos already contain the seed of — is the reconciliation layer: the deterministic engine that reads the agent's story against the record and tells a human what to trust.**

- PipeLab ships free, open-source, mediator-keyed signed receipts with broader capture (MCP+HTTP+WebSocket). Microsoft's Agent Governance Toolkit receipt proposal is in interop testing across four implementations. IETF drafts exist. The MCP roadmap itself names audit trails and gateway patterns as priorities.
- **None of them parse the agent's claims. None can run the Gmail draft-vs-send demo.** They attest traffic; nobody audits the narrative. That square is empty, and the June-13 THESIS named it ("claimed vs. actual") before the category had a name.

**The five forced changes:**

1. **Reposition one layer up.** Lyhna is the verification layer above receipts; the proxy and Codex adapter are declared capture scaffolding; adopt receipt standards, never author one.
2. **ICP shift.** Primary buyer = technical operators and boutique dev consultancies running coding/desktop agents unattended (they can install the path; they feel the pain). Marketing agencies are gated on hosted-platform capture — as framed in the draft they were simultaneously unreachable (local proxy vs. hosted traffic), unbothered (the sent folder is free), and disincentivized (granular records = margin transparency + discoverable liability).
3. **Trust ladder.** A local signing key is self-attestation to any third party; the signed core currently has no timestamp at all. Tier 0 (local) = internal-only, labeled on its face. Tier 1 (hosted countersign + trusted timestamp + transparency log) ships the day any receipt faces a third party — it is the subscription, not a premium afterthought.
4. **Labeler hardening before any marketing.** Code-verified bypasses exist today: a lie placed in free-text `result` with `action` omitted reads SUPPORTED (defeats the flagship draft-vs-send catch); a fully silent agent produces an all-green receipt; the DO_NOT_SEND trigger (`user_facing`) is supplied by the agent being policed. Fixes: OBSERVED_UNCLAIMED label; claims-tested denominator; action-family reconciliation of result verbs; tool-derived user_facing; coverage manifest; retire wrapper-crack claims until argument capture exists.
5. **Sell "stop checking," not "catch liars."** Retention = the artifact and the inbox; catches = the demo and the marketing moment. Subscription for the consultancy tier (countersigning + compatibility treadmill); perpetual+updates as the solo funnel; buy-once-as-model killed.

**The organizational pattern to break:** three times across three repos — the Codex adapter's broken plugin-install boundary, the proxy's RED Live-Bind Gate (no live signed loop ever captured), the witness's unpublished renderer and unsigned receipts — the same shape: immaculate, obsessively tested internals; unproven live edge. The sequencing rule in Thesis v2 (§14) exists because of this pattern: close the live edge before adding anything.

**Kill/pivot criterion:** two failed gates (of G1 stranger-install ≤10min; G2 inbox engagement; G3 receipts voluntarily shown to others; G4 anyone pays/renews) → human-read receipts are read-never artifacts → pivot the same engine to the agent-readable verified continuation (`next-ai-prompt`) as the primary product.

---

## PART 1 — PR #1 EVALUATION VERDICT (lyhna-codex-adapter, 2026-07-15)

Full report delivered in-session; summary preserved here for the record.

**VERDICT: FINDINGS.** Reviewed state: remote PR head `f61de1e` (= `codex/witnessed-run-v0`); local uncommitted v0.1.22 working tree, installed plugin cache, smoke evidence, and Codex CLI were on Adam's Windows machine and **not verifiable** from the evaluation environment.

| # | Severity | Finding |
|---|---|---|
| F1 | P0 | `plugins/lyhna/.mcp.json:2` uses a camelCase `mcpServers` wrapper that is not a documented Codex `.mcp.json` shape (docs allow a direct server map or snake_case `mcp_servers`); from the plugin install path the `lyhna` server never registers, so all ten tools — `begin_run`, `snapshot_pr`, `begin_evaluation`, `request_close` — are uncallable. Confirmed by the docs fetch and the unresolved hosted-Codex P1 review thread. |
| F2 | P1 | `scripts/validate-plugin.mjs:20-25` and `test/plugin.test.mjs:17-19` hard-code the same unsupported shape — the validators test the file against itself, never against Codex. 30/30 tests and the validator pass green on a head the runtime rejects. |
| F3 | P2 | Undocumented `.mcp.json` per-server fields (`env_vars`, `cwd`, `default_tools_approval_mode`) and unverified relative-path resolution — even after the direct-map fix, only an installed-runtime smoke proves registration. |
| F4 | P2 | Three version surfaces (plugin.json, package.json, mcp-server.mjs serverInfo) with no equality check — a partial 0.1.22 bump passes all checks. |
| F5 | P2 | PR body evidence stale/contradicted ("19/19 tests" vs 30 at head; earlier smoke claim contradicted by the reported 0.144.1 smoke). |
| F6 | P2 | `service.mjs` unknown-ID dereferences surface as generic REQUEST_FAILED instead of typed errors. |

Otherwise: all 13 resolved hosted-review threads verified as actually fixed at head; capability isolation, determinism, hash-chain/seal tamper detection, redaction, and honesty-ceiling language check out in code and tests. Recommended gate: apply direct-map fix → rerun installed-plugin smoke in fresh `LYHNA_CODEX_DATA` → commit/push → new hosted review → witnessed customer-zero loop.

---

## PART 2 — REPO MAP: lyhna-mcp-proxy (exploration subagent, full report)

**Repo:** `/workspace/lyhna-mcp-proxy` — npm package `@lyhna/mcp` v0.2.5, TypeScript, Node ≥20, MCP SDK ^1.29.0. ~11,850 LOC in `src/`, 37 test files / ~521 test cases. This repo is the runtime tool-call adapter; the witness repo owns the user-facing receipt and trust labels.

### 2.1 Vision

The proxy's job is to manufacture a portable, independently-verifiable proof object about what an AI agent's tool calls actually did. From `README.md:1-12`:

> "Point an agent runtime through Lyhna, run a loop, close it from the supervisor boundary, export a proof bundle and graph node — and verify it cold."
> "What the buyer receives is not the proxy itself — it is the **exported proof object**: a portable, independently verifiable record that a loop ran and closed under authority."

Sharpest one-liner (`README.md:12`): **"Permission grants access once. Lyhna attests authority every time."**

The honesty ceiling is the defining constraint (`CLAUDE.md:8-10`): "Lyhna only asserts *action-level witnessed truth*. Never let any surface imply an outcome was verified, work is correct, an email was sent, or that witnessing happened live."

Two personas, deliberately separated topologically: the **supervisor/operator** who opens/closes loops and receives the proof pack, and the **buyer/verifier** who cold-verifies an exported pack with zero Lyhna account. The agent under audit is not a user with authority — it "holds only a URL." Deliverables: the **capsule trio** — THE CARD (`proof-card.md`), THE HANDOFF (`HANDOFF.md`, assembled from the sealed during-run judgment ledger — "the agent cannot author its own report card"), THE SEED (`memory-injection.json`).

### 2.2 Architecture & concepts

Spine: **Scope Capsule in → governed loop of bind-gated tool calls → Continuation Capsule out**, with a signed receipt chain underneath and a judgment ledger recording the middle.

- **proxy-core** (`src/proxy-core.ts`) — interception heart: pre-bind scope check → `bind()` → forward-only-on-APPROVED → hash the runtime result. Never mutates forwarded payloads.
- **enforcement** (`src/enforcement.ts`) — `APPROVED→FORWARD`, `ESCALATED→HOLD_AWAIT_RESOLUTION`, `REFUSED`/default→`FAIL_CLOSED`. The default case failing closed is the whole safety posture in one switch.
- **bind** (`src/bind.ts`) — client contract to Lyhna's hosted authority; the proxy never mints receipts.
- **loop / loop-proof-bundle** (`src/loop.ts`, `loop-proof-bundle.ts` — 1,982 lines, the most defensive file) — mutex-serialized receipt chain; terminal `loop_close` seals; export packages a sealed chain into `receipts.json` (byte-identical verifier input) + `bundle.json` (advisory envelope) + graph node. External-scope-only (`tenant_hash`), content-blind (`goal_hash`), fail-closed.
- **judgment-recorder/-ledger/-reducer** — one ordered `JudgmentTurn` per consequential move: inherited state → proposed move → verdict → state delta; append-only contiguity; reducer folds to settled/open/next. Constitutional limit: "records what runtime result/error HASH the forwarded call returned (hashed, never interpreted)."
- **scope-capsule** — supervisor-sealed structural lane with two projections: content-blind structural projection (hashed into `scope_ref`; the only thing gate/bind/core see) and a plaintext sidecar never read by the gate. Canonicalizes targets against path-traversal; only `max_steps` is honored (declared `max_writes`/`max_budget` fail closed rather than imply an unenforced bound).
- **continuation-capsule** — the inheritance object emitted at close; Proof Mode strips plaintext, Verified Context Mode carries it plus a continuation prompt.
- **control-channel** — supervisor-only listener ("the ONLY surface that may open or close a loop"); owner-only unix socket / loopback-only TCP; verbs open/amend/close/status/dump/record_delta.
- **session-registry** — many concurrent loops keyed by session_id; one-loop-per-loop_id; `get()` is the only method on the agent's hot path.
- **push-pack / destinations/supabase** — optional durable persistence; idempotent insert + read-back verify; never required for export.
- **witness-bridge** — pairs agent claims with witnessed judgment turns (positionally or by explicit `turn_ref`) into the witness's input; a claim with no matching turn becomes `event: null` — "the dangerous 'claimed but never witnessed.'"
- **record-claim-tool / claim-recorder** — the only agent-facing addition: agent can WRITE a claim but never READ or alter the witnessed ledger.
- **cross-loop-verify** — pure offline two-pack checker for cross-loop inheritance; every report carries "Signature verification not performed here."
- **extractors/wrapper-registry** — declarative descriptors cracking wrapper tools to true operations: Zapier (`execute_zapier_*_action` → `zapier.<app>.<action>`) and Apify (`call-actor` → `apify.<actor>`). Two families total.

### 2.3 Evidence strength — it can BLOCK, not merely witness

The upstream tool is called **only** in the `decision === "FORWARD"` branch (`proxy-core.ts:96-345`), reached only after `bind()` returns APPROVED. The scope gate runs pre-bind; `max_steps` is enforced inside the loop mutex. Three real chokepoints: scope refusal, bind refusal/escalation, step bound. `AGENTS.md:44-54`: "No optimistic forwarding. No parallel 'bind while executing.'"

Because it sits in the data path it proves what hooks and self-report cannot: the actual tool name of every crossing call; a signed receipt per forwarded call, chained and sealed by a terminal event the agent cannot emit; runtime results hashed and linked. *Enforced:* bind outcome, structural scope lane, max_steps. *Recorded only:* result hashes, agent claims, supervisor declared_delta. Constitutional limit (`AGENTS.md:149-153`): "Record, hash, link — never judge." The proxy itself never verifies Ed25519 signatures — crypto is deferred to the independent `lyhna-verify`.

### 2.4 Maturity

**Works:** full golden path locally with nothing live (`npm run demo`: start → open → route synthetic call → supervisor close → dump → export → cold-verify against real `lyhna-verify`); CI runs typecheck+build+suite+verify-legs; ~521 test cases across 37 files (README stale: claims 108/14); Reliability Gauntlet driver parameterizes the real standing-service loop; `examples/live-loop` asserted byte-identical in tests.

**Aspirational:** **Leg 3 / Live-Bind Gate is fail-closed RED** (`docs/LIVE-BIND-GATE.md:143-158`) — no genuine hosted-bind full-green signed capture exists. Production isolation is a deployment requirement, not code (`docs/PRODUCTION-ISOLATION.md`) — the "proxy closes the loop" guarantee requires the proxy to run under a separate UID the agent can't signal. Wrapper registry has exactly two families; content-blind witnessing of wrapper arguments is deferred.

**Read:** the proof/export/verification core looks production-grade — obsessively fail-closed, dominated by adversarial validation. The live signed loop through a real hosted tenant and real agent is unproven. A very mature harness waiting on one live integration.

### 2.5 Integration surface

Transports: stdio proxy (one `.mcp.json` block — genuinely low-friction), Streamable HTTP per-task, standing HTTP multi-session (agent gets only `/mcp/<session_id>`), all on the official MCP SDK. Full capsule trio requires the supervisor surface (control channel + `export-pack`/`handoff`/`post`). Setup pain moderate and honestly documented: env-var sprawl (`LYHNA_PROXY_*`), PowerShell JSON-quoting, two-window split; bind modes deliberately safety-gated (default `stub:REFUSED`; hosted needs `LYHNA_API_KEY`; production cutover needs an explicit extra flag).

### 2.6 Nuggets

**Carry forward:** (1) the proof object, not the proxy, is the deliverable — decoupled generation/consumption; (2) the self-attestation boundary as architecture, not policy (agent-holds-a-URL / supervisor-holds-the-channel); (3) the honesty ceiling as product discipline — "record, hash, link — never judge"; claimed-but-never-witnessed as the dangerous case; (4) the two-projection content-blind model (structural hash vs. plaintext sidecar); (5) "the agent cannot author its own report card" — the handoff assembled from the sealed ledger.

**Drop/reconsider:** (1) the live signed loop is unproven — the single biggest gap; (2) cross-loop inheritance drives most of the 2,000-line defensive surface — consider identity-only linkage for v1; (3) `max_writes`/`max_budget` declared-but-unenforceable — don't ship bounds vocabulary you can't meter; (4) config-via-env sprawl — the desktop app framing is the intended fix; (5) stale self-reporting in the README of a don't-overclaim product.

---

## PART 3 — REPO MAP: lyhna-witness (exploration subagent, full report)

`/workspace/lyhna-witness` (main @ 01daf2f): a small zero-dependency Node engine plus an Electron desktop app, a static marketing site, and an unusually thick layer of strategy/testing docs. The "product layer" repo of the two-repo system.

### 3.1 Vision

Canonical: `THESIS.md` (2026-06-13, verbatim founder decision record). Product: "Lyhna is the independent witness in the path of an agent's real-world tool calls… claimed vs. actual… The agent is an unreliable witness to its own work." Core sentence reused everywhere: "Lyhna tells you what your AI agent actually did in your business systems, where that differs from what it claimed, and what the next human or AI can safely continue from."

The refuses-to-be-an-authority stance is explicit and load-bearing: `PROJECT-BRIEF.md` opens with a frame guardrail forbidding authority/gating/governance framing; `BUILD-PLAN.md` makes reintroducing it a mandatory hard-stop; `HANDOFF-DESKTOP.md` encodes it as a copy rule ("a not-safe run reads 'review before continuing,' never 'blocked'").

Imagined buyer (`LLM-CONTEXT.md` §1): "independent agent operators, local/private-AI users, Claude Code / Codex power users, consultants and agencies installing agent workflows for clients, and small businesses…" — the buyer moved over time from hosted-SaaS toward individual operators buying a local app. Sharpest value-prop statements: **"Run your agents. Walk away. Come back to receipts."** / "buy once · use with all your agents · unlimited local receipts · your receipts stay yours." / "The moat = the honesty ceiling… the demo survives 'have your own AI audit this receipt.'" / Adoption bet (THESIS §10): worker-agnostic witness layer on the MCP path — "the Datadog-like pattern."

### 3.2 Concepts

Witness/witnessed event (independent half); Claim via `record_claim` (agent can write claims, never read the ledger back); Claimed-vs-actual + trust labels computed by fixed rules (`src/labels.mjs`), never a model — SUPPORTED / UNSUPPORTED / NEEDS_EVIDENCE / NEEDS_HUMAN_APPROVAL / CLAIMED_ACTUAL_MISMATCH / SETTLED / REOPENED / SAFE_TO_CONTINUE / DO_NOT_SEND / DO_NOT_RE_LITIGATE; the Handoff/Receipt trio (HANDOFF.md + handoff.json + next-ai-prompt.md) as a "trust-marked continuation object"; Capsule index; the Spine/Contract for multi-agent attribution; OKF export (knowledge carrier) and PAM-shaped export (memory carrier) where every item carries `evidence_status` — "carriers prove transport integrity; Lyhna proves origin integrity; Lyhna feeds the carriers"; the proof spine kept "one click away, never the headline"; the receipt inbox (`src/capsule-indexer.mjs`, `inbox-cli.mjs`) as the data primitive the desktop app renders; `witness-input.json` as the wire format between repos.

### 3.3 What exists and maturity

**Works (mature, tested):** the deterministic zero-dep engine (labeler, generator, OKF/PAM/capsule projections, contract spine, two CLIs; suite grew 70→85→88→~170 tests; byte-for-byte drift gate; "no clock, no model calls, no randomness"). The witness CLI renders the full capsule offline from a clean clone. The marketing site is live on GitHub Pages; the demo is an honest replay of a committed real receipt.

**Desktop app:** feature-complete in-repo, not shippable. Electron + Vite/React over a vitest-tested zero-dep core (57 tests); full local loop works from source; a later lane bundled the engine via electron-builder and verified a packaged build on a clean profile; remaining blocker is **code-signing/notarization (owner certs)**. Deliberately never built: backend, accounts, billing, telemetry, cloud sync, fake "Connected" status. The web dashboard is a static preview, labeled as such.

**Dogfood (2026-06-15, 10 loops through the real proxy):** 10/10 behaved honestly. Caught: agent claiming it *sent* a client email when the witness saw only a draft (the signature catch); a failed migration and a blocked/escalated refund narrated as not done; a Zapier route mismatch handled content-blind; a two-agent continuation where A's claimed email is flagged unsafe and B's witnessed send is supported. Correctly never upgraded SUPPORTED into an outcome claim. Known limitation: an out-of-order unwitnessed claim mis-attributes positionally but fails safe.

**The most product-relevant testing signal:** the 30-scenario Reliability Gauntlet's first 30/30 mechanical pass "was itself a finding — the mechanical pass was insufficient." Adversarial *prose* audits found the real bugs: **F1 (P1 false-safe)** — a pure route-mismatch run rendered "✅ Safe to continue" (fixed: mismatch forces `safe_to_continue: false`); **F2** — blocked calls narrated as "ran but did not succeed" (fixed); the Black-Box Beta Panel found operator free-text (`settled`) rendering with witness-strength authority (fixed with "operator-declared, not witnessed" tags). Lesson verbatim: **"honesty bugs live in the prose and the verdict semantics, not only in the label sets."**

**Beta readiness:** GO for small invited beta; NOT for public npm beta — renderer `private: true` and unpublished; live-MCP test was subsequently run and passed (`LIVE-MCP-RUN-REPORT.md`: real filesystem server, real disk I/O; SUPPORTED / DO_NOT_SEND / CLAIMED_ACTUAL_MISMATCH all fired) — but with the **unsigned synthetic demo bind**, so real signing in the path remains unproven.

### 3.4 Evidence model

Witness-of-invocation, not witness-of-outcome, and scrupulous about it: SUPPORTED means "the call returned," with the note "the stated outcome is the agent's account, not independently witnessed." **Content-blindness is enforced in the data structure** — the ledger stores tool names, not arguments; consequence: the marquee wrapper app-cracking (claimed google_docs vs witnessed zapier→google_docs) **"does not fire in the production loop"** — only the coarse route mismatch does. Strongest real evidence: `examples/live-gmail/REAL-EVIDENCE.json` — genuinely captured `mcp__Gmail__create_draft` vs claimed "send" → MISMATCH/DO_NOT_SEND. Two disclosed weaknesses: ordinal claim↔turn pairing; all receipts to date unsigned.

### 3.5 Abandoned / superseded

Hosted/metered/private-beta SaaS → superseded 2026-06-18 by buy-once local desktop (with an active kill-list of buyer-surface language). Authority/gating positioning → deprecated and fenced off. Tauri → Electron (build-env constraint; revisit open). Hand-authored demos → the canonical loop-produced receipt. Standalone proof-pack file → dropped ("proof refs live inside the artifacts"). Standalone `lyhna-desktop` repo extraction — planned, blocked on owner.

### 3.6 Nuggets

**Carry:** (1) claimed-vs-actual computed deterministically — `labels.mjs` is a compact reference implementation with fail-closed carve-outs worked out; (2) the honesty ceiling as enforced discipline propagated into code, marketing, CI, and adversarial harnesses; (3) the adversarial-prose testing method (gauntlet + blind multi-role panels); (4) evidence-status-carrying projections (feed the carriers, don't compete); (5) the worker-agnostic adoption frame.

**Drop:** (1) the two-repo, no-npm, clone-to-render topology; (2) the production wrapper-app-cracking story (oversold vs. what the content-blind loop captures); (3) ordinal claim pairing; (4) unsigned receipts standing in for tamper-evidence; (5) the ~24-doc strategy scaffolding — carry the decisions, not the anxiety.

**Bottom line:** the durable asset is a philosophy plus a small, honest, deterministic engine that implements it. The packaging (desktop, repo split, unpublished renderer, unsigned receipts) is unfinished and partly mis-chosen; the marquee wrapper demo overstates what the production evidence model captures.

---

## PART 4 — ADVERSARIAL REVIEW A: BUYER / GTM SKEPTIC (full report)

**Steelman.** The thesis names a real failure mode (agents as unreliable narrators — confirmed by 2026 field literature on silent agent failures and tool-hallucination rising with reasoning training), has falsifiable kill gates, killed metered pricing and dashboard-first, and the claimed-vs-actual diff is genuinely distinct from observability telemetry. The category is real (PipeLab, Meridian Verity, Fetch.ai AEVS, an open Agent Receipts spec, an IETF compliance-receipts draft). The problem is that almost every GTM-load-bearing claim — who pays, why, how it installs, what the moat is — breaks on contact with how the named buyer operates.

### A1. The agency ICP does not want this receipt — it is discoverable liability, not a deliverable — **FATAL as framed**

(1) What agencies do today when an agent lies: check the sent folder / CRM / Stripe dashboard — the system of record already exists downstream of every action the wedge names; the workaround is free and takes eleven seconds. (2) Agency economics run on opacity: white-label guides are explicit that the model is service-price arbitrage over cheap platforms at 60–80% margins; disclosure research: granular AI disclosure "invites the question 'so should I be paying less?'" A signed per-action receipt is margin-compression documentation. (3) The receipt is discoverable evidence: California's 2026 law bars "the AI acted autonomously" as a defense; deployer liability is hardening; a tamper-evident log of every agent mistake is what opposing counsel subpoenas. **Neutralize:** reposition as internal QA/ops artifact ("never spot-check agent runs again"), client-facing receipts opt-in for transparency-demanding verticals, or flip to dispute *defense* ("when the client says 'your agent never sent it,' you have proof it did"). Nothing rescues white-label-receipt-as-default-deliverable.

### A2. White-label + local key destroys the independence moat exactly where it's monetized — **FATAL for the "proof" claim**

To the end client, a receipt generated on the agency's machine, signed with the agency's key, wearing the agency's logo, is self-attestation with extra steps. The independent-attestation literature (PipeLab mediator receipts; receiver-attested arXiv work) makes exactly this distinction. The fix — hosted countersigning — was explicitly deferred by the draft. Internal contradiction, not market risk. **Neutralize:** countersign/timestamp in v1 for the agency tier, or drop the client-facing claim and sell internal evidence.

### A3. Buy-once local desktop is a structural misfit for a treadmill product — **SERIOUS**

Buy-once works for version-stable products; Lyhna's value is staying compatible with churning surfaces (MCP spec revisions, Codex hook APIs — the adapter is already broken by one, integration drift, notarization). Every upstream change is unpaid maintenance against collected revenue; buy-once also caps the agency relationship at one transaction where expansion revenue should live. Twelve-month realism: a well-executed indie launch plus ten founder-priced deals ≈ $30k–$120k — funds a person, not a category bet. **Neutralize:** perpetual + paid annual updates for solo (JetBrains fallback); subscription for the agency tier. Buy-once survives as a funnel tactic, not the model.

### A4. The local proxy cannot see the ICP's traffic, and the 10-minute stranger can't install it — **SERIOUS → FATAL for the agency ICP**

Agencies run agents on hosted platforms (Zapier, n8n cloud, Make, hosted GPT builders); those tool calls execute in someone else's cloud and never transit the operator's desktop. A local MCP proxy witnesses none of it. Partial coverage is corrosive for a witness product: unwitnessed actions labeled UNSUPPORTED either train users to ignore labels or cry wolf. And the population that edits MCP configs to interpose a proxy is developers, full stop — G1 will be passed by the wrong persona and misread as ICP validation. **Neutralize:** admit the capture surface defines the ICP — v1 buyer is the technical operator/boutique dev consultancy; hosted-platform capture is the explicit expansion gate for agencies. Nothing neutralizes "non-technical operator installs a local MCP proxy."

### A5. The DO_NOT_SEND wedge decays into an unread smoke detector — **SERIOUS**

False claims of consequential outbound actions are real but the per-small-shop incident rate likely runs monthly, not weekly; after week one without a catch, felt value collapses to a green-checkmark generator. G3 (≥1 catch/week/partner) is the gate most likely to fail. Buy-once accidentally hedges this (churn-by-prepayment), killing referrals. **Neutralize:** sell the artifact, not the catch — the always-on record ("come back to receipts"), CI-badge/dashcam model; catches become the marketing moment. Replace G3 with an engagement gate.

### A6. Outbound HOLD re-invents natively shipped HITL — **MANAGEABLE but reopens a settled decision for a losing fight**

OpenAI Agents SDK pause-for-approval, Claude Code permissions, Dify Human Input, n8n HITL templates, Zapier manual approval steps — platform-native approval beats a proxy HOLD on UX because the platform owns the agent's state machine. The defensible version is narrow: a single cross-platform approval inbox bound to the receipt. **Neutralize:** evidence-completeness feature and checkbox, never headline or pricing anchor. If WTP concentrates there, that signals an approval company — a different, worse company to start.

### A7. Bundle: moat/compliance/execution

- Open Agent Receipts spec + IETF draft already exist → "receipt schema as our open standard" is not Lyhna's to own; conform and compete on the diff. (MANAGEABLE)
- EU AI Act tailwind decorative: Art. 12 binds high-risk (Annex III) providers — not marketing agencies; possibly delayed by the Digital Omnibus. Drop or accept it points at the deferred enterprise buyer. (MANAGEABLE)
- The core loop has never run live (RED gate, zero signed receipts, broken adapter, no installer) while the 90-day plan packs 6–9 months of work. Cut the plan to one thing: a signed receipt on real traffic in a stranger's hands. (SERIOUS)
- Datadog analogy fails: no breadth, no daily-workflow lock-in, anti-Datadog pricing. The survivable position is the cross-platform, user-side verifier. (SERIOUS, partially neutralizable)

### A: Three most lethal + strongest surviving thesis

**Lethal:** (1) A1+A4 — the ICP mirage: unreachable, unbothered, disincentivized; (2) A2 — the independence contradiction ("trust product that overstated its trust model" is unrecoverable in this category); (3) A5 — smoke-detector decay killing retention and referrals.

**Strongest surviving thesis (as stated by the adversary):** "Lyhna is the verification harness for people who run coding and desktop agents unattended — sold to technical operators and boutique dev consultancies, not marketing agencies. It captures locally (where its proxy can actually see traffic), diffs the agent's claims against witnessed calls — the one primitive nobody else in the receipts category leads with — and emits receipts conforming to the existing open spec. The retention product is the artifact, not the alarm… Pricing: perpetual + paid updates for solo; subscription for consultancies, where hosted countersigning — shipped the day any receipt is shown to a third party, not 'later' — is what they're paying for. Hosted-platform capture is the explicit gate to ever saying the word 'agency' again… the honest bet is that people pay to stop checking, not to catch liars."

*(Source URLs preserved in Part 8.)*

---

## PART 5 — ADVERSARIAL REVIEW B: PLATFORM & COMPETITION SKEPTIC (full report)

**Steelman.** One real insight: the agent is an unreliable narrator, and the claims-vs-actual diff is a different artifact from a log. Nobody in the 2026 landscape ships a deterministic engine that diffs what the agent said against what was witnessed and emits DO_NOT_SEND before a false "sent/paid" reaches a human. Independence has live evidentiary support: OpenAI's Codex began encrypting inter-agent delegation messages in June 2026, degrading local auditability, complaint still open — a live demonstration that the platform's log serves the platform. The emerging enterprise reference architecture reserves a slot for exactly this layer.

### B1. Platform absorption — **SERIOUS**

OpenAI ships an immutable Compliance Platform + Audit Logs API; Anthropic ships a Compliance API and enterprise audit logs; Zapier ships per-agent run pages free with the product — a screenshot answers 90% of "what did the agent do" for $0. "Independence" is epistemically correct and commercially inert in the SMB segment; buyers pay for convenience and coverage and demand independence only after an incident or under compulsion. **Counter-evidence to exploit:** platform logs are control-plane heavy (Anthropic's export excludes content), unsigned, platform-attested, and actively degradable (the Codex encryption episode); demand for agent-action logs is spiking while platform supply stays control-plane. **Neutralize:** stop selling independence as a principle; sell the capability the platform structurally can't ship — the cross-platform claims-vs-actual diff. Anthropic can log Claude; it cannot diff Claude's claims against Zapier's, Gmail's, and Codex's witnessed reality in one receipt, and it has no incentive to flag its own agent's confabulations. Nothing fully neutralizes "the platform ships good-enough and the SMB market stops looking."

### B2. Protocol absorption — **SERIOUS, trending FATAL for proxy-as-product on 12–24 months**

The MCP roadmap names Enterprise Readiness with "audit trails and observability" and "gateway and proxy patterns" as the first bullets; SEP-414 locked W3C Trace Context into `_meta`. Signed receipts are being standardized around MCP from three directions: an IETF draft for signed decision receipts in the MCP ecosystem; server-side Ed25519 audience-bound receipts in `_meta` (Vouched/Checkpoint); attested tool-server admission (arXiv). When receipts are a protocol extension emitted by servers and verified by hosts, the proxy's witnessing is a redundant hop. Mitigations: extensions diffuse slowly; a server-emitted receipt proves the server was called, not that the agent's summary to the human was true. **Neutralize:** invert the relationship — be the biggest cheerleader of MCP-native receipts; declare the proxy scaffolding; the durable product consumes receipts and diffs them against claims; join the Enterprise WG now and be the reference implementation. If the thesis doubles down on the proxy as moat, nothing neutralizes this.

### B3. Category timing — **FATAL for the thesis as written**

The core artifact — signed, hash-chained, offline-verifiable, mediator-signed action receipts — already exists, shipped, free, open-source, with broader capture: PipeLab's Pipelock (MCP+HTTP+WebSocket egress enforcement, Ed25519 mediator receipts, public spec, reference verifiers in four languages, launched by May 2026). Meridian Verity's headline is the HOLD bet (ACCEPT/HOLD/REFUSE, fail-closed, replayable receipts). Microsoft AGT verifiable-compliance-receipts: draft with interop testing across four implementations, LangChain/AutoGen/CrewAI in the discussion. Nuggets ships signed action receipts for LangChain/LangGraph tool calls. Against this: Lyhna July 2026 — unsigned receipts, RED live-bind gate, unpublished renderer, no installer, broken adapter, solo founder. Every ranked moat item is someone else's shipped headline. **Neutralize (kills two moat claims):** adopt, don't author — emit Pipelock/AGT/ACTA formats as they converge; weeks 3–6 of the draft plan (local signing end-to-end) is building a worse version of a free thing. Reposition one layer up: the claims-vs-actual diff with trust labels and the human-readable handoff. PipeLab proves the agent's traffic; nobody proves the agent's story. If "signed receipt" stays the headline noun, nothing neutralizes — you're 6+ months behind free.

### B4. The Datadog analogy is decorative — **MANAGEABLE**

Datadog won on cross-platform breadth at a platform shift, daily-workflow lock-in, land-and-expand economics, and integration network effects. Lyhna: one wire + one broken adapter; a document read after the fact (no one lives in their receipts); buy-once anti-Datadog pricing that can't fund the integration treadmill. **Neutralize:** drop the analogy, or take it seriously — the workflow-lock-in equivalent is the inbox + the HOLD queue; if operators approve held actions in Lyhna daily, that justifies subscription pricing. Buy-once and Datadog-pattern are mutually exclusive; pick one on purpose.

### B5. The MCP-path bet — the witness watches a minority of the risk — **SERIOUS**

No data supports "most consequential agent actions flow through user-insertable MCP proxies"; structural evidence points the other way. MCP's highest-volume use is coding tools — low on the consequence list. Payments arrive with their own receipt layer (Google AP2, 60+ partners, production since April 2026). Browser/computer-use agents execute UI actions that never touch an MCP server (agent traffic est. 25–35% of operational web traffic by end-2026). Hosted agent surfaces don't accept a local proxy at all. Inside coding agents, actions happen via shell/code execution — the Codex adapter exists precisely because the proxy can't see that plane, and Codex now encrypts inter-agent messages. Honest statement: Lyhna witnesses the MCP-mediated, locally-hosted slice; "no claimed 'sent/paid' reaches you without a witnessed call" is false the moment the agent pays via AP2 or clicks Send in a browser. **Neutralize:** (a) honest scoping — unwitnessed planes labeled UNSUPPORTED by default is a feature, the blind spot becomes visible epistemic honesty; (b) capture surfaces as a funded portfolio (proxy, hooks, browser capture, AP2 mandate ingestion) feeding one diff engine — a multi-year roadmap, not a 90-day solo plan. Nothing makes the MCP-only witness see the whole risk surface; stop implying it does.

### B6. Additional breaks

- **B6a. White-label trust-model contradiction — SERIOUS/FATAL for the ICP as specced.** The agency is the root-level adversary the client needs protection from; PipeLab's own key-custody test indicts the v1 local key. Pull hosted countersigning into the 90-day plan; for this ICP it is the product's claim to exist.
- **B6b. Regulatory tailwind misfit — MANAGEABLE.** Art. 12 binds providers of high-risk systems; citing it while deferring the enterprise buyer borrows urgency from a buyer you chose not to serve. PipeLab is already marketing the Art. 26 deployer angle — that is the honest one.
- **B6c. Adapter treadmill fragility — MANAGEABLE, chronic.** Codex broke the adapter at a config boundary and changed internals mid-2026 with no regard for observers. Adapters as community/open-source surfaces around a stable receipt-consuming core, not owned product surfaces.
- **B6d. Buried differentiator.** The genuinely defensible asset — deterministic claims-vs-actual diff, trust labels, adversarial gauntlet, blind-auditor validation — is one clause in the pipeline sentence, while the moat section majors in the three most contested squares (independence, schema, capture).

### B: Three most lethal + strongest surviving thesis

**Lethal:** (1) B3 category timing — the headline artifact lost the race to free before the plan starts; (2) B6a — the GTM and the cryptography contradict each other; (3) B2+B5 pincer — the proxy is absorbed from below (MCP roadmap) and bypassed from the side (AP2, browser, hosted connectors) simultaneously.

**Strongest surviving thesis (as stated by the adversary):** "Lyhna is not the receipt layer — receipts are becoming free infrastructure. Lyhna is the verification-and-handoff layer above receipts: the deterministic engine that diffs an agent's claims against witnessed evidence — from its own proxy today, and from Pipelock/AGT/ACTA/protocol-native receipts as those standards land — and emits trust-labeled, human-readable verdicts before an agent's false 'sent/paid/done' reaches a human. The MCP proxy and Codex adapter are disposable capture scaffolding, and the company says so out loud… Unwitnessed planes are labeled UNSUPPORTED rather than papered over — the blind spot becomes the honesty feature. The moat is a two-year head start in the adversarial minutiae of claims-parsing and diffing, not schemas, not capture, not independence-as-principle… the agent is an unreliable narrator, and someone has to read the story against the record."

*(Source URLs preserved in Part 8.)*

---

## PART 6 — ADVERSARIAL REVIEW C: TECHNICAL EVIDENCE-VALUE SKEPTIC (full report; code-grounded)

Read: `labels.mjs`, `proxy-core.ts`, `enforcement.ts`, `record-claim-tool.ts`, `claim-recorder.ts`, `witness-bridge.ts`, `witnessed-event.mjs`, `bind.ts`, `bind-client/configured.ts`, `receipt-recorder.ts`, `loop-proof-bundle.ts`, `judgment-ledger.ts`, plus thesis docs.

**Steelman.** The one defensible claim is narrow and real: for tool calls actually routed through the proxy, Lyhna records what crossed the boundary independently of the agent's narration, and a deterministic ruleset — not a model — flags: (a) a claim with no witnessed call behind it, (b) a claimed route/action differing from the witnessed one, (c) a call the witness could not read. The code backs this up: `computeStepLabels` is genuinely deterministic; the fail-closed posture is real (unclaimed *failed* calls don't launder to safe, labels.mjs:165-176; unreadable wrapper calls fail closed, 199-207; approval survives every early return, 296-297). The draft-vs-send catch is a real signal observability tools do not produce, because their trace trusts the agent. If marketed at exactly this altitude, defensible. The thesis markets above it.

### C1. Content-blind witnessing gives near-zero assurance on the thing that matters — **FATAL for the wedge as written; MANAGEABLE re-scoped**

The ledger stores tool name + result hash, never arguments (witness-bridge.ts:11-13, 72-84). The witnessed half of every step is: *a gmail-family tool ran and returned bytes whose sha256 is X*. Recipient, subject, amount — none in evidence. Scenarios reading SUPPORTED/SAFE while something bad happened: prompt-injected `gmail.send` to attacker@evil.com with customer data (route matches, action matches, returned → SUPPORTED); $50,000 instead of $500 in a `graphql_mutation`; the decoy pattern — real damage via bash/curl off-path, one benign witnessed read routed through the proxy, claim matches → SUPPORTED, the receipt affirmatively vouches for a session whose damage happened off-camera. **Fix:** split the promise — keep the content-blind spine; add optional **argument commitments** (salted hashes of recipient/amount/target pinned into the receipt) so "the send that ran was to the recipient the agent claimed" is assertable. Without them, drop the verb "did": the honest claim is "a call of this shape occurred."

### C2. The claim side is voluntary — a silent agent collapses the product to a green activity log — **SERIOUS**

`record_claim` records only what the agent chooses to state. A witnessed call with no claim is labeled **SUPPORTED** (labels.mjs:165-176), so a fully silent agent yields all-green and `safe_to_continue: true` (generate.mjs:72-76) with zero claims tested. The headline is then dishonest for the silent case — the default for any agent not instrumented to call record_claim. **Fix (the single most important honesty fix):** (1) no-claim witnessed calls become `OBSERVED_UNCLAIMED`, never SUPPORTED, never counted toward a green headline; (2) a **claims-tested denominator** in the top-line verdict; a zero-claim run is branded "activity log (no claims to verify)."

### C3. Local Ed25519 signing proves nothing to a third party; the draft "fix" removes the only independent party — **FATAL for white-label; MANAGEABLE for receipts-for-myself**

`lyhna-verify` green = internally-consistent chain signed by whatever key is embedded in the same pack (`pinTrustRoot`, loop-proof-bundle.ts:381-393, 1708-1709). No external anchor, no identity binding, no transparency log, and **no time field in the signed turn core at all** (judgment-ledger.ts:148-166). For white-label, the audience differs from the machine owner; an agency can fabricate any chain and it verifies green. The draft made it worse: the current architecture at least routes bind() to a hosted signer (bind-client/configured.ts:70-89); replacing it with a local supervisor key deletes the one component giving receipts third-party value. "Tamper-evident" becomes an overclaim bordering on inversion — tamper-evident only against adversaries weaker than the machine owner, who is precisely the party the client needs assurance against. **Honest language:** "tamper-evident against post-hoc edits by anyone below root on this machine" — nothing more. **Minimal architecture for real third-party receipts:** hosted countersignature + trusted time; transparency log (Rekor-style or hosted Merkle log); tenant identity binding. For the named primary buyer this is the product, not a premium tier.

### C4. Coverage is "what you route through it" — a minority of consequential actions — **SERIOUS; interacts lethally with C2**

The proxy witnesses only MCP calls through it (proxy-core.ts:96); the engine's own docs admit unrouted agents "simply never appear here" (generate.mjs:207). Shell, curl, browser, direct SDK calls are invisible — no witnessed event and (if silent) no claim, so not even an UNSUPPORTED flag. For a realistic coding/ops agent, the consequential surface is dominated by bash/file-writes/git/direct HTTP: plausibly 10–40% witnessed, ~0% for an agent that shells out, and the witnessed set is whatever the operator remembered to route — an adversarial agent avoids it deliberately. **Fix:** (1) a **coverage manifest** on every receipt naming witnessed surfaces and stating that shell/browser/direct-API were not; (2) the honest product statement is "Lyhna witnesses what you route through it" — which survives for a controlled/locked-egress deployment and does not survive for general agents; lead with the locked config as a requirement.

### C5. Outbound HOLD changes the threat model, the liability, and contradicts the brand — **MANAGEABLE if firewalled, SERIOUS as wedge**

HOLD is real enforcement: `decideForward` → HOLD_AWAIT_RESOLUTION throws before forwarding (enforcement.ts:9-10; proxy-core.ts:332-338); bind failure fails closed (298-304). Consequences: Lyhna availability becomes a hard dependency for legitimate work; liability inverts (a wrong HOLD *causes* business loss — false positives, latency, SLAs); brand contradiction — an enforcement gate is authority gating, which the thesis's own non-goals forbid; "held for your approval" is a euphemism, not a changed threat model. **Fix:** fail-open-by-policy option (witness-and-warn) with the customer choosing fail-open vs fail-closed explicitly; positioning "witness by default, optional gate you turn on and own"; price/contract for the SLA enforcement implies.

### C6. The deterministic labeler can be gamed into SUPPORTED by claim phrasing — **SERIOUS-to-FATAL for the guarantee**

- **C6a. Omit `action`, put the lie in `result` → SUPPORTED (defeats the flagship catch).** Action mismatch requires both sides' `action` present (labels.mjs:111); result mismatch requires both `result`s present (116) but the witness never sets `result` on success (witnessed-event.mjs:164-170); `actionUnverified` is suppressed whenever `witnessed.action` exists (253-259) — and it always does, derived from the tool name. So: agent runs `gmail.create_draft`, claims `{system:"gmail", result:"sent the invoice to the client"}` with no `action` → no mismatch, backstop suppressed → **SUPPORTED** with only a soft note. The celebrated Gmail catch fires only because the demo agent volunteered `action:"send"`. The guarantee holds only against an agent that self-incriminates in the structured field.
- **C6b. `user_facing` — the DO_NOT_SEND trigger — is agent-controlled** (labels.mjs:146,152-153; record-claim-tool.ts:47-50). Omitting it on a fabricated "I emailed the client" claim avoids the headline label. The most dangerous label is opt-in by the party being policed.
- **C6c. Generic-invocation carve-out** (`APP_INVOCATION_ACTIONS`, labels.mjs:27, 250-259): a specific opaque action can read as a supported generic invocation.

**Fixes:** reconcile free-text result verbs by action family ("said sent / tool was create_draft" → MISMATCH regardless of field omission); derive `user_facing` from witnessed tool identity for outbound families; a claim missing `action` on a witnessed consequential call fails closed to NEEDS_EVIDENCE. Until these land, "deterministic = trustworthy" is only true against a cooperative narrator.

### C7. Other issues

- "Cold-verifiable" invites over-reading: green = self-consistent chain signed by the embedded key, full stop (the verify line itself hedges "advisory," loop-proof-bundle.ts:1597, 1709).
- No trusted time anywhere in the signed spine — "when did the agent do this" is unanswerable; material for any compliance pitch.
- The RED live-bind gate + all-unsigned-receipts status means every "signed receipt" claim is presently aspirational (configured.ts:59-61).
- The wrapper-crack needs arguments the signed pack deliberately discards (wrapper-registry.ts:44-59 vs witness-bridge.ts:11-13) — a live-only, unsigned capability that a receipt reader cannot re-verify.

### C: Three most lethal + strongest technically-honest version

**Lethal:** (1) C3 — the draft's trust-model "fix" removes the only independent party for the named buyer; (2) C6a — the flagship guarantee is defeated by omitting one field; (3) C2×C4 — green means "clean within the minority of actions you routed, about which the agent chose to speak," and the receipt never prints its own denominator.

**Strongest technically-honest version (as stated by the adversary):** "Lyhna is a tamper-evident, deterministic reconciliation log for the tool calls you route through it. For a locked-egress agent, Lyhna records every consequential call independently of the agent's narration, and a fixed ruleset flags four things the agent's own report can't be trusted on: a claim with no call behind it, a route/action that differs from what the agent said, a call it couldn't read, and any claim it never tested. Every receipt prints its coverage boundary and its claim denominator, and it never renders green for an unclaimed or unread call. Content-level facts are covered only where you enable argument commitments… Third-party-credible receipts require hosted countersignature + trusted timestamp; the local-key pack is tamper-evident only against edits below root on your own machine, and says so on its face." Close the gap between "a witnessed, deterministic reconciliation of the calls you routed and the claims you made about them" and "proof of what happened" — land the six fixes — and there's a defensible company. Ship at the current altitude and the first competent security reviewer dismantles it in one meeting.

---

## PART 7 — CONVERGENCE TABLE (attack → disposition → where encoded in Thesis v2)

| Attack | Adversaries | Disposition | Thesis v2 |
|---|---|---|---|
| Receipts/capture/signing commoditized (Pipelock, AGT, IETF, MCP roadmap) | B (FATAL as written) | Accepted — reposition one layer up; adopt formats | §1, §3, §4, §15 |
| Agency ICP unreachable/unbothered/disincentivized | A (FATAL), B (B6a) | Accepted — ICP shift; agencies gated on hosted capture | §9 |
| Local key = self-attestation to third parties; no trusted time | B, C (FATAL for white-label) | Accepted — trust ladder; Tier 1 in v1 for any third-party audience | §6 |
| Labeler gameable (result-verb bypass; silent agent all-green; agent-sourced user_facing) | C (SERIOUS-FATAL) | Accepted — six hardening requirements block all marketing | §7 |
| Coverage minority + no denominator | B, C (SERIOUS) | Accepted — coverage manifest + claims denominator, constitutional | §6, §7 |
| Smoke-detector decay of the catch wedge | A (SERIOUS) | Accepted — artifact/inbox retention; catch = demo; engagement gate | §10, §14 |
| HOLD reinvents native HITL; inverts liability; contradicts brand | A, C (MANAGEABLE if bounded) | Bounded — opt-in, fail-open option, never headline; Fork B | §11, §16 |
| Buy-once misfit for treadmill product | A (SERIOUS) | Accepted — subscription tier + perpetual funnel | §12 |
| Datadog analogy decorative | B (MANAGEABLE) | Retired — reader-of-receipts + capture portfolio | §13 |
| EU AI Act citation misfit | A, B (MANAGEABLE) | Dropped from pitch; Art. 26 reserved for enterprise motion | §9 |
| Wrapper app-crack oversold vs production loop | repo map, C | Retired from buyer surfaces until argument capture | §7.6 |
| Immaculate internals / unproven live edge (org pattern ×3) | evaluator + both repo maps | Sequencing rule: close the live edge first | §14 |
| Content-blindness vs "right recipient/right amount" | C (FATAL for wedge phrasing) | Tier 2 argument commitments as first premium; verb discipline in copy | §6 |
| Claims-vs-actual is the empty square (nobody audits narrative) | A, B, C (all affirm) | The product | §1, §5 |

---

## PART 8 — SOURCE INDEX

**Category / competitors / standards:** PipeLab (pipelab.org — Pipelock, action-receipt spec, mediator receipts, EU-AI-Act deployer page) · Meridian Verity (meridianverity.com) · Microsoft Agent Governance Toolkit verifiable-compliance-receipts proposal + issue #1499 + MS OSS blog (2026-04-02) · IETF draft-farley-acta-signed-receipts-01; draft-marques-asqav-compliance-receipts · Agent Receipts open spec (agentreceipts.ai) · Vouched/Checkpoint MCP receipts · Nuggets/LangChain signed action receipts (NatLawReview) · Fetch.ai AEVS (Crypto Briefing) · arXiv: Notarized Agents (2606.04193); Verifiability-First Agents (2512.17259); attested tool-server admission (2605.24248).

**Protocol / platforms:** MCP Roadmap (modelcontextprotocol.io/development/roadmap) · MCP 2026-07-28 RC (SEP-414 trace context) · OpenAI Compliance Platform + Audit Logs API · Anthropic/Claude Compliance API + audit logs (+ General Analysis guide; codenote.net on gaps) · Zapier agent activity pages + audit logs · WinBuzzer 2026-07-15: Codex encrypts inter-agent messages, audit complaint open · BankInfoSecurity: "Everyone Suddenly Wants Claude's Audit Logs."

**Market structure:** Google AP2 agents-to-payments protocol (cloud.google.com; ap2-protocol.org) · MCP adoption statistics (mcpmanager.ai; andrew.ooo) · O-mega browser-agent traffic estimates · MCP gateway field (Integrate.io roundup; MintMCP; Lunar.dev) · agent observability field (aimultiple; latitude.so; mlflow.org; confident-ai; laminar.sh; langchain.com).

**Buyer behavior / legal:** white-label AI agency economics (HyperFX; NAZCO) · AI-disclosure ethics (theaicareerlab) · agentic-AI liability (Clifford Chance; The Lyon Firm) · EU AI Act Art. 12 (artificialintelligenceact.eu; netguardia; Help Net Security; Asqav) · HITL norms (Waxell; getclaw) · pricing models (Creem on perpetual licenses; Wingback on subscription fatigue) · agent failure literature (Towards AI silent failures; Arize common failures; manveerc on tool hallucination).

**Internal evidence:** `lyhna-witness` — THESIS.md, PROJECT-BRIEF.md, BUILD-PLAN.md, HUMAN-GUIDE.md, LLM-CONTEXT.md, RELIABILITY-GAUNTLET.md, BLACK-BOX-BETA-PANEL.md, BETA-READINESS-REPORT.md, STRANGER-INSTALL-REPORT.md, LIVE-MCP-RUN-REPORT.md, dogfood/DOGFOOD-LOG.md, src/labels.mjs, src/generate.mjs, src/witnessed-event.mjs, src/contract.mjs · `lyhna-mcp-proxy` — README.md, CLAUDE.md, AGENTS.md, LLM-CONTEXT.md, docs/LIVE-BIND-GATE.md, docs/PRODUCTION-ISOLATION.md, docs/QUICKSTART.md, src/proxy-core.ts, enforcement.ts, loop.ts, loop-proof-bundle.ts, judgment-ledger.ts, scope-capsule.ts, control-channel.ts, witness-bridge.ts, record-claim-tool.ts, claim-recorder.ts, bind-client/configured.ts, extractors/wrapper-registry.ts · `lyhna-codex-adapter` — PR #1 at f61de1e (SPEC.md, plugins/lyhna/*, scripts/validate-plugin.mjs), hosted-Codex review threads.

---

*End of dossier. Companion: `THESIS-V2.md`. Both drafted 2026-07-15 by the evaluator session; canonical status of Thesis v2 is Adam's decision.*
