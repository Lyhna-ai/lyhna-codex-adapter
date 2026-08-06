# Slice 1 transport spike — 2026-08-05

Status: **PASSED**. This is installed-host transport evidence, not a product correctness verdict.

## Contract

The pre-code gate was conjunctive. The slice had to stop as `BLOCKED_TRANSPORT` if any of these
assertions failed:

1. `PostToolUse` returns changed model-visible `additionalContext`.
2. `Stop` returns `decision: "block"` and the parent session continues.
3. `SubagentStop` persists a child terminal observation that becomes visible at a later supported
   parent boundary. Direct injection into the parent context was not required.
4. Control state survives separate hook-process invocations.
5. An identical diagnostic remains deduplicated after process restart.

## Exercise

A disposable, uniquely named Codex plugin was clean-installed into the desktop host and exercised
through an ephemeral `codex exec` session. The probe used fixed, non-secret canary markers and an
append-only JSONL ledger beneath the plugin data directory. The installed probe and its temporary
marketplace registration were removed after the exercise.

Observed model-visible markers:

```text
LYHNA_SPIKE_POSTTOOL_6C4D2A
LYHNA_SPIKE_CHILD_TERMINAL_4A8F20
LYHNA_SPIKE_STOP_CONTINUATION_91B7E3
```

The parent response also observed `stop_hook_active: true` after the blocked Stop continuation.

## Ledger result

The probe ledger recorded distinct operating-system process identifiers across hook invocations,
one `diagnostic_emitted`, later `diagnostic_suppressed` events for the unchanged input, child start
and terminal observations, later parent delivery of that child terminal marker, and Stop ordinals
one and two. The second Stop invocation still observed the prior Stop state.

Codex emitted a host-store message saying it could not find the spawned subagent thread. That did
not invalidate the transport assertion: the host still invoked both `SubagentStart` and
`SubagentStop`, the terminal event persisted, and the next parent `PostToolUse` boundary delivered
the marker. The assertion concerns hook transport and persistence, not the host's thread index.

## Boundary

This spike establishes the installed Codex hook channel used by Slice 1. It does not establish
production probe authenticity, GitHub pagination, the Slice 2 quiet join, publication, deployment,
or any external action gate.
