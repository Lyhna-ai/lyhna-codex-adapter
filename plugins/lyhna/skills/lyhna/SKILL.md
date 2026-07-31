---
name: lyhna
description: Start or continue an explicitly requested local Lyhna witnessed run in Codex, or retrospectively examine an existing GitHub pull request with an explicit no-build-record limitation.
---

# Lyhna

Use this skill only when the user explicitly invokes Lyhna or asks for a witnessed run or retrospective Lyhna PR examination.

## Constitutional boundary

The builder produces. The evaluator examines. Lyhna witnesses. The user decides.

Never say Lyhna approves, blocks, certifies, guarantees, merges, or proves commercial, architectural, legal, operational, or product correctness. Hook absence means only `not observed` within configured coverage.

## Choosing the mode

Use `mode: "full"` whenever the request asks to build, change, fix, continue, or delegate work — even partially. Use `mode: "pr_only"` only when the request is explicitly and solely a retrospective examination of an existing PR with no build work. When ambiguous, choose `full`: a full run that observes little is honest, while a retrospective run over active build work misattributes the session.

## Start a full witnessed run

1. Read the `LYHNA_SESSION_CAPABILITY` supplied in SessionStart context.
2. Call `begin_run` with `mode: "full"` before consequential work. Preserve the user's objective without strengthening it. If this window continues an earlier one, pass that window's `capsule_ref` as `continues_from`.
3. Use `record_claim` for consequential completion statements, citing event or artifact references when available.
4. Build normally. Lyhna hooks record only their supported lifecycle coverage.
5. When a PR exists, call `snapshot_pr` for the repository and PR number.
6. Call `begin_evaluation` with the current trusted repository working directory as `source_cwd`, then delegate that request to a fresh child evaluator. The path is used operationally to prepare the checkout but is not retained in the durable run record. Do not give the evaluator builder narration as primary evidence. Optionally pass `trigger` (`initial`, `post_fix_reeval`, `gate_audit`, or `re_examination`) to record why this evaluation runs; omit it when unknown — Lyhna records `unspecified` and never infers a reason.
7. The evaluator uses its hook-issued `LYHNA_CHILD_CAPABILITY`, calls `claim_evaluation`, independently records the checkout SHA, tracked cleanliness, and detached-HEAD state before its checks, runs its own checks without fixing code, and calls `record_evaluation` with those before observations. Lyhna re-inspects the managed checkout for the after observations.
8. After delegated children stop, call `list_child_receipts`. Call `read_sealed_receipt` for every evaluator receipt before relying on its report; ordinary child receipts prove only lifecycle coverage and are already surfaced in the parent receipt.
9. Address findings in the builder lane. A changed PR head requires a new snapshot and evaluator pass. Each earlier head then renders `SUPERSEDED` and only the final head can render `CURRENT`.
10. After the final evaluation, call `refresh_pr` on the final head before closing. A refresh observed after the last evaluation with an unchanged head lets that head render `CURRENT`; without it the receipt honestly stamps the head `NOT_REFRESHED`. Closing still proceeds either way — Lyhna never claims a head is current that it did not observe refreshed.
11. Call `request_close`. The next Stop hook seals only if every ordinary child has stopped with a sealed lifecycle receipt and required evaluator receipt retrieval is complete.

Every Stop hook writes a checkpoint packet — the current `receipt.json`, `RECEIPT.md`, and a `checkpoint-anchor.json` — so the run is a verifiable packet at its latest checkpoint even before it seals. The receipt face states its lifecycle honestly: `SEALED`; close-requested-but-not-yet-sealed, with the deferred-close blockers surfaced as observations; or `OPEN` with no close request observed. At seal the single seal anchor replaces the checkpoint anchor. This is observation, never an intent judgment.

## Continue across context windows

A long task outlives one context window. Switching windows is normal and should be cheap; what makes it expensive is that the handoff is usually a document the outgoing agent writes about itself, so errors compound window over window.

Every Stop writes `continuation.json` and `HANDOFF.md` into the run packet, folded from the hash-chained ledger by the hook path. You do not author these files and cannot edit them. Do not write a separate handoff summary of your own and do not restate their contents as if you had verified them.

1. When a window is ending, point the user at `HANDOFF.md` in the run packet. Its fenced block is what they paste into the next window.
2. In the next window, call `begin_run` with `continues_from` set to the prior `capsule_ref`. Lyhna resolves that reference against the local packet and records the prior carry-forward state hash itself; a reference it cannot resolve is recorded as `UNRESOLVED_LOCALLY` rather than rejected or assumed.
3. Claim text is retained by default (`privacy_mode: verified_context`), so the capsule names which claim is unsupported rather than only how many. Use `privacy_mode: "proof"` at `begin_run` only when the packet is meant to leave the owner's machine; it projects claim text out of the receipt and continuation while keeping every support label and evidence reference. The mode is fixed at run start and cannot be changed afterward.
4. Treat every claim as unverified unless you re-check it in this window — including claims labeled `REFERENCES_RESOLVE`. That label means the cited references point at events the run witnessed; whether they actually bear on the claim was never evaluated, so a resolving reference is not verification. `UNSUPPORTED` and `UNRESOLVED_EVIDENCE` claims are unverified outright, and the legacy `SUPPORTED` label (packets folded by 0.1.31 and earlier) meant only that references resolved — treat it exactly like `REFERENCES_RESOLVE`. A prior window's confidence is not evidence.
5. Each sealed capsule is signed with the local key and carries its own public key. Report a signature as proving who folded the capsule and that it is unchanged — never as proving the observations were true. An unsigned capsule is unsigned, not tampered; say so plainly.
6. A human can verify the chain independently with `node scripts/verify-lineage.mjs <prior-run-dir> <current-run-dir>`. Never claim a chain is verified that you have not seen that checker pass.

Lyhna reports whether a window inherited what it says it inherited. It does not judge whether the continuation was a good idea.

## Examine an existing PR

1. Call `begin_run` with `mode: "pr_only"`.
2. Snapshot the PR, delegate the same independent evaluator flow, retrieve its receipt, and request close.
3. Preserve `build_record: unavailable` unless an earlier witnessed run is explicitly linked. GitHub history is not silently promoted into witnessed build evidence.

## Evidence labels

- MCP-routed adapter action: `mcp_routed`
- Codex hook observation: `runtime_hook`
- Builder assertion: `agent_reported`
- Evaluator finding: `evaluator_reported`
- Sanitized GitHub metadata: `github_observed`
- Missing coverage: `unobserved`

Do not paste secrets, environment values, full commands, full outputs, PR bodies, or comment bodies into Lyhna tool arguments.
