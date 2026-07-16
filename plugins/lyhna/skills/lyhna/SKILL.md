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
2. Call `begin_run` with `mode: "full"` before consequential work. Preserve the user's objective without strengthening it.
3. Use `record_claim` for consequential completion statements, citing event or artifact references when available.
4. Build normally. Lyhna hooks record only their supported lifecycle coverage.
5. When a PR exists, call `snapshot_pr` for the repository and PR number.
6. Call `begin_evaluation` with the current trusted repository working directory as `source_cwd`, then delegate that request to a fresh child evaluator. The path is used operationally to prepare the checkout but is not retained in the durable run record. Do not give the evaluator builder narration as primary evidence.
7. The evaluator uses its hook-issued `LYHNA_CHILD_CAPABILITY`, calls `claim_evaluation`, independently records the checkout SHA, tracked cleanliness, and detached-HEAD state before its checks, runs its own checks without fixing code, and calls `record_evaluation` with those before observations. Lyhna re-inspects the managed checkout for the after observations.
8. After delegated children stop, call `list_child_receipts`. Call `read_sealed_receipt` for every evaluator receipt before relying on its report; ordinary child receipts prove only lifecycle coverage and are already surfaced in the parent receipt.
9. Address findings in the builder lane. A changed PR head requires a new snapshot and evaluator pass.
10. Call `request_close`. The next Stop hook seals only if every ordinary child has stopped with a sealed lifecycle receipt and required evaluator receipt retrieval is complete.

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
