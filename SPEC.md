# SPEC — Codex witnessed-run adapter v0

## Goal

Prove one Codex-only customer-zero slice in which `@lyhna` starts a local witnessed run where work already happens, preserves supported action evidence through Codex hooks and an MCP tool surface, and closes with an evidence-scoped receipt. The same plugin must also examine an existing pull request retrospectively while stating that no witnessed build record exists.

The adapter records what was observed. It never approves, certifies, merges, deploys, or declares
the work commercially, architecturally, legally, or operationally correct. For an explicitly
declared claim contract, it may refuse an unsupported Lyhna claim or successful seal; it does not
block the underlying external action.

## Normative claim-compiler addendum

For v0.1.33 and later, implementations and reviews must also follow
[`docs/proposals/CLAIM-COMPILER-SPEC-2026-08-05.md`](docs/proposals/CLAIM-COMPILER-SPEC-2026-08-05.md).
It remains normative until a named successor specification explicitly supersedes it. That ratified
addendum supplements this specification and controls every claim-compiler-specific technical
requirement where the two documents conflict, including fold v2, profile compilation, unsupported
seal refusal, and the five-PR merge authorization. Every base invariant it does not explicitly
change remains binding.

## Repository boundary

- All new product code lives in `Lyhna-ai/lyhna-codex-adapter`.
- `lyhna-witness`, `lyhna-mcp-proxy`, and `lyhna-core` remain untouched.
- The adapter may consume pinned, read-only versions of existing Lyhna components. A missing core capability becomes a documented follow-up, not an opportunistic sibling-repo edit.
- Runtime evidence stays under a local user data directory and is never committed by default.

## User paths

### Full witnessed run

1. The user explicitly invokes Lyhna. The mention is recognized anywhere in the prompt, not only at its start, on a real word boundary, in any of four accepted forms: a structured plugin mention (a markdown link whose target contains `plugin://lyhna-codex-adapter`, with or without an `@` in the display text, or the bare plugin URI itself), the literal long form `@lyhna-codex-adapter` with an optional `@marketplace` suffix, the literal short form `@lyhna`, or `$lyhna` where Codex uses skill mentions. Structured host payloads (arrays or objects of prompt parts) are coerced to text before matching. Preamble text before the mention no longer defeats capture; prompts that mention lyhna without matching any form leave a content-free miss marker for field diagnosis.
2. The skill calls `begin_run` before consequential work.
3. Supported Codex lifecycle hooks append coverage-scoped events while the run is active.
4. Consequential agent assertions use `record_claim` with evidence references.
5. Child-agent start and stop events create separately sealed child receipts.
6. After the build produces a PR, the same run snapshots its exact head and delegates an evaluation request to a separate evaluator child.
7. The evaluator works from a detached checkout pinned to that SHA, records attributed findings from its own child capability, and stops. The parent retrieves the sealed evaluator receipt.
8. A parent review claim is supported only after `read_sealed_receipt` retrieves that child receipt.
9. The parent calls `request_close`; the next `Stop` hook verifies that no required child/evaluation is still open, seals the run, and renders its receipt. Without a recorded close request, `Stop` only checkpoints the current turn.

### Existing pull request

1. The user invokes `@lyhna` with an existing GitHub pull request.
2. `snapshot_pr` records repository, PR number, base SHA, head SHA, files, checks, review objects, review comments, issue comments, and snapshot failures.
3. The receipt declares `build_record: unavailable` unless a prior witnessed run is explicitly linked.
4. An independent evaluator examines the original request when available and a detached checkout at the captured head. Its findings remain attributed evaluator opinions.
5. `refresh_pr` explicitly rechecks the current head. A different head marks the snapshot and evaluation `STALE`; it does not erase the earlier receipt. V0 does not claim continuous monitoring.

## Plugin and runtime interfaces

- Plugin identifier: `lyhna-codex-adapter`; user-facing display name: `Lyhna`; bundled skill: `lyhna`.
- Explicit invocation only. Installing the plugin does not silently turn every task into a witnessed run.
- Bundled hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop`.
- `SessionStart` mints an unguessable capability bound to the hook-observed Codex `session_id`. `SubagentStart` mints a separate child capability bound to the hook-observed `agent_id` and parent session. Agents cannot choose these trust anchors.
- Agent-facing MCP tools:
  - `begin_run(session_capability, mode, objective?)`
  - `record_claim(session_capability, statement, evidence_refs[])`
  - `snapshot_pr(session_capability, repository, pr_number)`
  - `begin_evaluation(session_capability, pr_snapshot_id)`
  - `claim_evaluation(child_capability, evaluation_request_id)`
  - `record_evaluation(child_capability, finding, evidence_refs[])`
  - `refresh_pr(session_capability, pr_snapshot_id)`
  - `list_child_receipts(session_capability)`
  - `read_sealed_receipt(session_capability, receipt_id)`
  - `request_close(session_capability, reason)`
- The store rejects evaluation submissions whose capability belongs to the builder/parent session or to a child not bound to that evaluation request.
- Supervisor-only hook handlers own checkpointing, child sealing, parent sealing, and rendering. They are not MCP tools.

## Evidence contract

- Evidence origins are explicit: `mcp_routed`, `runtime_hook`, `agent_reported`, `evaluator_reported`, `github_observed`, `imported`, or `unobserved`.
- Absence inside configured coverage means `not observed`; it never proves the action did not happen elsewhere.
- Hook capture is broader but weaker than a Lyhna-routed MCP call. `PreToolUse` supports only “attempt observed”; a paired `PostToolUse` supports “tool returned” with its recorded outcome. Permission and lifecycle events never prove execution. `runtime_hook` remains visibly distinct from `mcp_routed` in every receipt.
- The event ledger is append-only, sequence-numbered, hash-chained, crash-safe, and idempotent for repeated hook delivery. A separately persisted final seal anchor retains the sealed sequence and hash so tail deletion is detected on later reads.
- Hook and MCP payloads are schema-tolerant: stable shared fields are normalized and unknown fields are ignored or safely summarized.
- Builder claim text is retained, with secrets scrubbed and length bounded. A claim is the agent's own assertion, to this owner, about this owner's work, on this owner's machine — there is no third party whose privacy is served by hiding it, and a claimed-vs-actual system that will not show the claim has discarded the half of the diff only a human can judge.
- Withholding is a projection applied when a packet leaves the machine, never a storage decision made on the owner's behalf. `privacy_mode` is `verified_context` (default, claim text retained) or `proof` (claim text projected out of the receipt and continuation, support label and evidence references retained). It is fixed at run start, sealed into `run_begun`, and read from state — never from the environment — so re-rendering a packet always reproduces its anchored bytes.
- Raw secrets, environment values, full command output, full tool responses, PR bodies, and comment bodies are not stored. The adapter stores redacted bounded titles/status summaries, structural metadata, and SHA-256 references.
- The objective is retained alongside its structural summary, secrets scrubbed and length bounded, and projected away in `proof` mode exactly as claim text is. "What was requested" is the first thing a reader needs and the first thing a successor window inherits; storing it as a byte count discards the authored product and keeps only the generated material.
- The original prompt is captured only for an explicitly invoked or already active Lyhna run. If Codex does not expose the invocation text to the hook, `begin_run.objective` is retained as `agent_reported` rather than promoted to hook-observed truth.
- Identical normalized receipt input produces byte-identical Markdown and JSON output.
- “Append-only,” “sealed,” and “cannot rewrite” are logical local-store properties, not adversary-resistant claims against an agent with unrestricted filesystem access. Reads verify the hash chain and surface deletion or mutation as `LOCAL_CHAIN_BROKEN`; v0 does not claim cryptographic custody beyond that detection boundary.

## Continuation and lineage across context windows

- Every Stop writes `continuation.json` and `HANDOFF.md` into the run packet, including for a window that is abandoned rather than closed. The common real case is a window ending because it became expensive, not because the work reached a boundary.
- **Every fold a Stop publishes stays resolvable and verifiable for as long as the packet exists.** `continuation.json` is the run's current face and each later Stop overwrites it, so every fold is also archived immutably inside the packet under its content-addressed ref (`capsules/<capsule_ref>.json`). The archive is self-authenticating — a file either hashes to its own name or it is not that capsule — so a successor holding a handoff from any earlier Stop resolves it (`RESOLVED_LOCAL_ARCHIVE`) and the lineage checker verifies the committed edge against the archived fold, stating plainly that the run later superseded it. A handoff that stops working because the window kept going would be the product's own failure mode, inverted.
- **An archive is authenticated three ways before the checker accepts it as the inherited edge.** Content: the bytes must hash to the ref the successor committed. Signature: the ref deliberately excludes the signature block, so the archived fold's signature is verified on its own — unsigned is unsigned, never tampered; present-and-invalid fails. Residence: content-addressing says what an archive *is*, not *whose* it is — a valid signed archive copied from another packet passes the first two checks perfectly — so the fold's committed ledger tip must appear at exactly the position it names in this packet's chain, and its run identity must match the refold-verified face. Chains from different runs share no event hashes, so a planted archive cannot satisfy the bond. Repair paths recreate a missing archive only from bytes that hash to the ref they claim, and a missing handoff is re-projected directly from a surviving, self-validating capsule — fold-candidate ambiguity gates only the regeneration it actually makes ambiguous.
- **A sealed packet is not whole without its handoff tail, and seal repair restores it.** A crash after `run_sealed` became durable but before the capsule, handoff, or index landed is recovered by the seal-verification path, which is the only path that revisits a sealed packet.
- **A capsule written by any Stop must actually verify, and an open capsule is resolvable exactly as a sealed one is.** Two things follow, and neither is optional: the fold must be taken over the ledger as it stands *after* the checkpoint anchor is appended, since the checker re-folds from the packet's own post-anchor state and full ledger; and every capsule is indexed by `capsule_ref` when it is written, not only at seal, or a successor handed an open capsule's exact reference records `UNRESOLVED_LOCALLY` with a null state hash and can never match the inheritance commitment. A handoff promised for the abandoned window that only verifies once the window seals is the promise inverted.
- Both files are deterministic folds of `(state, ledger)` produced by the supervisor hook path. The agent's MCP surface can append claims; it cannot author the fold, set a support label, or seal. Identical input produces byte-identical output.
- `settled`, `open`, and `next` are derived from structural observations and each carries the evidence reference it was derived from. They are never agent narration.
- Builder claims are labeled against the ledger: `REFERENCES_RESOLVE` when every cited reference resolves to an event witnessed in that run, `UNSUPPORTED` when nothing is cited or everything cited is the agent's own narration, and `UNRESOLVED_EVIDENCE` when a cited reference does not resolve within configured coverage. `UNRESOLVED_EVIDENCE` is deliberately distinct — a reference this run cannot resolve may be valid elsewhere, and calling it unsupported would overclaim.
- **A resolving reference is not support, and the label must not say it is.** `REFERENCES_RESOLVE` states exactly what the system can establish: the reference points at something this run witnessed. It says nothing about whether that something bears on the statement. "I deployed production" citing `run_begun` resolves perfectly and proves only that the run began. No allowlist of citable event types repairs this — an unrelated but legitimate tool return proves the wrong action just as well. Semantic support is a judgment this system does not make, and the earlier `SUPPORTED` label claimed it.
- **An agent-authored event is never evidence.** A reference resolving to an `agent_reported` event — another builder claim — supports nothing, and a claim whose references resolve only to such events is `UNSUPPORTED`, not `UNRESOLVED_EVIDENCE`: the reference resolved. The ledger witnesses that a claim was *made*; it never witnesses that it was *true*.
- **No builder claim is promoted into `settled`.** `settled` is terminal, witnessed facts a successor may rely on without redoing the work, and no structural check establishes that an agent's statement is true. Claims appear in the claims list with their labels, where a reader judges them.
- `begin_run` accepts `continues_from`, a prior `capsule_ref`. The store resolves it against the local packet and records that packet's `state_hash` itself; the caller cannot supply it. An unresolvable reference is recorded as `UNRESOLVED_LOCALLY`, never rejected or invented.
- The inheritance edge is written into `run_begun`, so it is inside the hash chain and covered by the seal anchor. It cannot be added or altered afterward without breaking the chain.
- Continuation artifacts are deliberately not hash-anchored like the receipt. They are pure projections, so lineage verification re-folds them from the ledger — which catches a file regenerated wholesale with a matching hash, something a stored hash cannot.
- **Re-folding does not by itself preserve read-compat; explicit fold versioning does.** Re-folding with whatever code is running means any change to the fold reports untampered historical packets as mismatched — an accusation of tampering against a packet that was never touched. Each shipped fold shape is therefore kept and selected explicitly: `v0_1_28` omits both `privacy_mode` and `objective_text`; `v0_1_29_30` includes `privacy_mode` but omits `objective_text`; `v0` is the 0.1.31 shape with both fields; and `v1` is 0.1.32 onward with corrected claim semantics. Historical reducers are preserved verbatim and never used for new packets. A packet's capsule and carry-forward state hash are both re-folded under the generation that wrote them.
- **Fold dispatch reads the hash chain, never the capsule.** From 0.1.32 the fold generation is committed directly in the `run_sealed` / `checkpoint_anchor` payload as `continuation_fold_version`, and dispatch prefers that chained declaration. Packets from builds that predate the field use a closed mapping of renderer to shipped fold candidates (`0.1.28` → `v0_1_28`; `0.1.29` → `v0_1_29_30`; `0.1.30` → `v0` or `v0_1_29_30`, because `objective_text` entered the carry-forward mid-version before the release was cut and the released bundle folds the `v0` shape; `0.1.31` → `v0`) — never an open-ended version range, which would silently fold a renderer from the future with current rules. Where a renderer maps to more than one shipped shape, the packet's own bytes decide: the checker accepts whichever candidate reproduces the published capsule byte-for-byte, and reports which matched. This is content-addressed dispatch over a fixed set of legitimate shipped shapes, not "the reducer that makes it verify" — the candidates share identical claim semantics, the set is fixed in the checker rather than by anything in the packet, and matching still requires bytes that actually refold from the hash-chained ledger. The capsule also declares the field for a reader, but verification must never dispatch on the capsule's copy: the capsule is unanchored, so trusting it would let a forged packet select the reducer under which it verifies. A declared generation the checker does not implement, or a renderer it cannot place, yields `NOT_RUN` and fails safe.
- **Historical integrity and current-policy trust are separate questions and are reported separately.** Whether a packet reproduces the fold it declared gates the verdict. Whether its claim labels still mean what the current rules mean does not — a packet written under a superseded fold can be perfectly intact while carrying labels this build would not issue. The report states the prior fold generation and marks superseded claim semantics plainly, and old capsule refs and state hashes are never rewritten.
- A sealed capsule is signed with a local Ed25519 key, and the public key is embedded in the capsule (trust-on-first-use). The key lives beside the packets under the data root, minted on first use.
- Key file protection is platform-dependent and is reported rather than assumed. On POSIX the file is written `0600` and is owner-only. On Windows `chmod` cannot express a POSIX mode, so the key is protected by the ACL inherited from its directory — user-restricted under `%USERPROFILE%`, and no more restricted than the data root if `LYHNA_CODEX_DATA` points elsewhere. `keyProtection()` states which applies, and `lyhna-key show` prints it. `key_id` is parameterized so a per-job or per-project key is configuration rather than redesign; v0 uses one default key.
- `capsule_ref` is derived over the capsule WITHOUT its own ref and WITHOUT the signature: the ref names the work, the signature attests it. The same fold signed by a second party keeps the same `capsule_ref`, which is what permits later counter-signing.
- Ed25519 is deterministic, so a signed packet re-renders byte-identically and the determinism contract still holds.
- A signature proves the holder of that key folded exactly those bytes and that none changed since. It does not prove the observations were true, and it does not defend against the key holder editing their own ledger before folding. Signing gives integrity and continuity in transit and over time; it is not custody against the machine that produced the packet.
- An unsigned capsule is reported as unsigned, never as tampered — a packet can be complete and hash-verifiable with no key present. A signature that is present and invalid does fail.
- Losing the key file is unrecoverable by design: already-folded capsules still verify against their embedded public key, while new capsules carry a new identity. `scripts/lyhna-key.mjs export`/`import` exists so an identity can be carried across machines deliberately.
- `verify-lineage` is an offline, directory-based checker that re-walks both chains itself rather than trusting the store's reader. A `LINKED` result is a local structural finding: internal consistency plus a genuine inheritance commitment. It is not cryptographic custody and must never be reported as such.
- Every lineage report carries every check, in a fixed order. A check whose input was destroyed by an earlier failure is reported `NOT_RUN` (rendered `NOT RUN`) with the reason it could not be evaluated; it is never omitted. Dropping the row would let "this could not be checked" read as "this did not apply" — the collapse `UNRESOLVED_EVIDENCE` exists to prevent one layer down — and would let a row silently disappear between two reports a reader is comparing. A `NOT_RUN` check is not a pass: the verdict requires every check to have actually passed, so an unknown fails safe even if some future path reaches it without an accompanying failure.
- The fixed order is a floor, not a ceiling: a result recorded under a name the sequence does not carry is appended to the report, never dropped. A checker that silently discards a recorded `FAIL` would return `LINKED` on a packet that failed.
- A destroyed input is a finding, not a crash. A packet file that is missing, empty, malformed, or not the shape it should be — `continuation.json`, `state.json`, or any ledger line — is reported as a failed check, because a one-byte truncation is precisely the tamper this checker exists to catch and a stack trace is not a report. An emptied `events.jsonl` fails as a destroyed chain; it is never read as a valid chain of length zero.

## Independent evaluation rule

- The builder and evaluator must be different agents.
- The evaluator starts from the original request, this specification, and a detached checkout at the frozen head; builder narration is not its primary evidence.
- The evaluator’s source checkout is treated as read-only by protocol, while test/build artifacts may be written outside tracked source. V0 does not claim operating-system enforcement against deliberate tampering.
- The evaluator verifies detached `HEAD` and a clean tracked tree before and after its checks. The PR snapshot records `head_before` and `head_after`; a mismatch produces `INCONSISTENT_SNAPSHOT` instead of an exact-head claim. A dirty tracked tree produces an explicit checkout-integrity exception rather than a pristine-head claim.
- The evaluator runs its own relevant checks and cannot silently fix findings.
- A builder may address findings, but every new head requires a fresh evaluator pass.
- Lyhna witnesses what the evaluator inspected and ran. It does not convert the evaluator's conclusions into certified truth.

## Acceptance checks

1. Plugin manifest and bundled skill validate with the Codex plugin validators.
2. A new Codex process can install and list the plugin and its MCP server.
3. Hook fixtures prove active-run filtering, redaction, idempotency, ordering, child sealing, and parent receipt retrieval.
4. MCP protocol tests cover valid calls, malformed input, missing sessions, capability isolation, builder/evaluator inequality, duplicate claims, and sealed-run immutability.
5. A synthetic full run produces a receipt containing observed actions, a failed action, a child receipt, and an unsupported claim without overstating coverage.
6. The synthetic full run continues through PR snapshot, distinct evaluator child, exact-head finding, evaluator-receipt retrieval, close request, and sealed parent receipt.
7. A seeded mismatch that builder tests intentionally miss is found by the distinct evaluator and remains attributed to it.
8. A PR-only fixture produces an exact-head receipt with `build_record: unavailable`.
9. Head drift during snapshot produces `INCONSISTENT_SNAPSHOT`; an explicit later refresh marks the earlier evaluation `STALE`. Tracked evaluator edits are surfaced even when `HEAD` is unchanged.
10. Receipt assertions distinguish attempt, returned outcome, permission/lifecycle observation, MCP-routed evidence, and self-report.
11. A real new Codex process installs the plugin and completes one full run with a child evaluator against a disposable repository; fixture-only simulation is insufficient.
12. Windows local execution uses ordinary files and loopback/process stdio only; no Unix-domain socket is required.
13. Ledger mutation, reordering, middle deletion, and sealed-tail deletion surface `LOCAL_CHAIN_BROKEN` rather than a normal receipt.
14. The complete diff receives an independent Codex review against this specification and all material findings are closed on the final head.
15. Pull requests remain unmerged for Adam's decision unless Adam gives a narrower explicit merge
    authorization. On 2026-08-05 Adam authorized Codex to squash-merge claim-compiler PR #13 and
    four implementation slices in this repository, based on `main`, with exact branches
    `codex/claim-compiler-contract`, `codex/claim-compiler-join`,
    `codex/claim-compiler-evidence`, and `codex/claim-compiler-recurrence`, after every declared
    exact-head gate is terminal and clean. Before each future merge, the recorded gate mapping must
    match repository, PR, base, slice, branch, reviewed head, and expected version. This is not
    standing merge, release, deployment, or production-mutation authority.

## Non-goals for v0

- Claude Code, Claude Cowork, ChatGPT Work, Telegram, or other host adapters. Claude GitHub review automation is also deferred by Adam’s current instruction until the Codex product slice is accepted.
- Hosted signing or hosted Lyhna service requirements.
- Universal interception of tools Codex does not expose to hooks or route through Lyhna.
- A new PR viewer, merge control, deployment approval, or business-correctness judgment.
- Publishing or changing any core Lyhna package.
- Continuous GitHub monitoring or automatic background staleness detection.
