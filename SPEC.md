# SPEC — Codex witnessed-run adapter v0

## Goal

Prove one Codex-only customer-zero slice in which `@lyhna` starts a local witnessed run where work already happens, preserves supported action evidence through Codex hooks and an MCP tool surface, and closes with an evidence-scoped receipt. The same plugin must also examine an existing pull request retrospectively while stating that no witnessed build record exists.

The adapter records what was observed. It never approves, blocks, certifies, merges, or declares the work commercially, architecturally, legally, or operationally correct.

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
- The original prompt is captured only for an explicitly invoked or already active Lyhna run. If Codex does not expose the invocation text to the hook, `begin_run.objective` is retained as `agent_reported` rather than promoted to hook-observed truth.
- Identical normalized receipt input produces byte-identical Markdown and JSON output.
- “Append-only,” “sealed,” and “cannot rewrite” are logical local-store properties, not adversary-resistant claims against an agent with unrestricted filesystem access. Reads verify the hash chain and surface deletion or mutation as `LOCAL_CHAIN_BROKEN`; v0 does not claim cryptographic custody beyond that detection boundary.

## Continuation and lineage across context windows

- Every Stop writes `continuation.json` and `HANDOFF.md` into the run packet, including for a window that is abandoned rather than closed. The common real case is a window ending because it became expensive, not because the work reached a boundary.
- Both files are deterministic folds of `(state, ledger)` produced by the supervisor hook path. The agent's MCP surface can append claims; it cannot author the fold, set a support label, or seal. Identical input produces byte-identical output.
- `settled`, `open`, and `next` are derived from structural observations and each carries the evidence reference it was derived from. They are never agent narration.
- Builder claims are labeled against the ledger: `SUPPORTED` when every cited reference resolves to an event witnessed in that run, `UNSUPPORTED` when no evidence is cited, and `UNRESOLVED_EVIDENCE` when a cited reference does not resolve within configured coverage. `UNRESOLVED_EVIDENCE` is deliberately distinct — a reference this run cannot resolve may be valid elsewhere, and calling it unsupported would overclaim.
- `begin_run` accepts `continues_from`, a prior `capsule_ref`. The store resolves it against the local packet and records that packet's `state_hash` itself; the caller cannot supply it. An unresolvable reference is recorded as `UNRESOLVED_LOCALLY`, never rejected or invented.
- The inheritance edge is written into `run_begun`, so it is inside the hash chain and covered by the seal anchor. It cannot be added or altered afterward without breaking the chain.
- Continuation artifacts are deliberately not hash-anchored like the receipt. They are pure projections, so lineage verification re-folds them from the ledger — which catches a file regenerated wholesale with a matching hash, and preserves read-compat with packets sealed by an earlier renderer.
- `verify-lineage` is an offline, directory-based checker that re-walks both chains itself rather than trusting the store's reader. A `LINKED` result is a local structural finding: internal consistency plus a genuine inheritance commitment. It is not cryptographic custody and must never be reported as such.

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
15. The final GitHub pull request remains unmerged for Adam's decision.

## Non-goals for v0

- Claude Code, Claude Cowork, ChatGPT Work, Telegram, or other host adapters. Claude GitHub review automation is also deferred by Adam’s current instruction until the Codex product slice is accepted.
- Hosted signing or hosted Lyhna service requirements.
- Universal interception of tools Codex does not expose to hooks or route through Lyhna.
- A new PR viewer, merge control, deployment approval, or business-correctness judgment.
- Publishing or changing any core Lyhna package.
- Continuous GitHub monitoring or automatic background staleness detection.
