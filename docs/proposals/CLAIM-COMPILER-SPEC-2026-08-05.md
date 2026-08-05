# RATIFIED SPEC — Lyhna Witness claim compiler

**Status: RATIFIED by Adam on 2026-08-05.** This document is the build contract for the v0.1.33+
claim-compiler line. It changes no runtime behavior by itself. Runtime behavior changes only through
the four independently verified implementation slices below.

## Provenance and product boundary

This contract merges three diagnoses of one recurring failure:

- completion was narrated while requested evidence was still pending;
- prose lessons decayed and recurring failures were logged as new observations;
- contradictions arrived after the owner had already been told the work was complete.

The resulting capability is: **compile the strongest completion claim current primary evidence
supports, surface a changed contradiction inline, and refuse an unsupported Lyhna seal at a
declared gate.**

Lyhna remains an independent, cross-project Codex plugin. Homestead is a customer, never a
dependency. No Homestead concept enters the core schema. Lyhna does not approve work, certify
correctness, merge, deploy, or prevent an external action. It may refuse to issue an unsupported
Lyhna claim or successful seal.

## Hard invariants

1. **Primary-evidence firewall.** Only primary events emitted through registered supervisor-owned
   boundaries may satisfy profile requirements. Compiler, gate, diagnostic, receipt, recurrence,
   and other derived events are never eligible evidence, even when their bytes and hashes are valid.
2. **Ledger-backed control state.** Close attempts, primary frontiers, input digests, diagnostic
   emission and resolution, quiet-period samples, cursors, and deduplication state are events on the
   existing ledger. Hook-process memory is never authoritative.
3. **Sealing is terminal.** Nothing is appended after `run_sealed`. A post-seal tail is corruption
   and fails closed. Later contradictory evidence belongs to a successor run linked through
   `capsule_ref`; `claim_superseded` is written only in that successor.
4. **Honest failure seals.** The first and second unchanged unsupported Stop attempts continue the
   parent with a generated diagnostic. The third unchanged attempt seals `CLOSED_UNSUPPORTED`,
   releases the session, and permits a new run. It never promotes the requested state.
5. **Immutable contract.** A contract is declared once per run. A changed objective or profile
   requires an honest close and a new run; no in-run amendment tool exists.
6. **One origin taxonomy.** New origins extend the existing evidence-origin enum. There is no
   parallel trust vocabulary.
7. **No generic evidence submission.** An agent may request a registered producer but cannot submit
   a production probe receipt or arbitrary evidence payload.
8. **Determinism.** Compiler and continuation reducers use no clock, model, network, or randomness.
   They consume witnessed timestamps and cursors from their inputs.
9. **Local honesty ceiling.** Hash-chain verification detects ordinary local mutation and deletion;
   it does not authenticate production reality or custody against the machine owner.
10. **Orchestration stays outside the product.** Watchdogs, worker replacement, and PR-driving
    machinery are build-process controls, not claim-compiler features.

## Profile and contract model

The compiler accepts a validated prerequisite graph. Node identifiers and display strings are
profile-defined. The first bundled profile is `software_release/v1`:

1. `BUILT` — exact source identity plus declared executable checks at that identity.
2. `MERGED` — the exact source identity or its merge commit observed on the named base.
3. `DEPLOYED` — the configured producer observed a running artifact identity matching the merged
   identity and required configuration presence, never configuration values.
4. `LIVE_PROVEN` — a dated registered canary observed the bounded terminal effect and any
   profile-required reconciliation or replay behavior.

These nodes are not a universal ladder. Other projects provide validated profiles with their own
nodes and prerequisites. A profile snapshot is canonicalized, hashed, and anchored into the
contract. A locally declared profile states the chosen requirements; it does not prove those
requirements are sufficient.

An immutable contract contains:

```text
contract_id
profile_id and profile_hash
requested_state
declared_gate_ids
named producer IDs and expected identities
objective_ref
verifier
caps
privacy_mode
```

The official completion result is a generated closeout envelope. Free-form prose is neither parsed
nor accepted as completion evidence. Generated language always states profile, state, scope, and
evidence frontier and never emits the bare word "works."

## Public and supervisor interfaces

Agent-facing tools:

```text
declare_claim_contract(session_capability, contract)
request_claim_producer(session_capability, contract_id, producer_id)
evaluate_claim_gate(session_capability, contract_id, gate_id)
request_close(session_capability, reason)
```

`request_close.reason` remains narration only. It asks the supervisor to evaluate the already
declared contract. There is no agent-facing `submit_evidence`, `record_probe`, or contract-amendment
tool.

Evidence enters through supervisor-owned hooks, the GitHub observer, or registered project probe
adapters. A producer request is not evidence.

## Ledger event contract

Primary event families:

```text
claim_contract_declared
producer_requested
producer_terminal
evidence_observed
gate_sample_observed
closeout_attempted
claim_superseded
```

Derived, permanently non-evidentiary event families:

```text
claim_compiled
gate_evaluated
diagnostic_emitted
diagnostic_resolved
closeout_envelope_generated
enforcement_required
```

Every derived event carries `claim_contract_ref`, `fold_version`, `input_digest`, and the primary
frontier it summarized. A fresh fold recomputes only from eligible primary events. Unchanged input
does not append another compile result, diagnostic, or resolution.

The existing origin enum is extended to exactly:

```text
mcp_routed
runtime_hook
agent_reported
evaluator_reported
github_observed
imported
unobserved
registered_probe
mock_or_test
```

Profiles name accepted origins, event kinds, producer identities, and identity bindings for every
requirement. `mock_or_test` can exercise logic but cannot satisfy production requirements. An
agent-reported payload marked production remains agent-reported and ineligible.

## Deterministic compiler output

The pure compiler returns:

```text
contract_id
profile_ref
requested_state
highest_supported_state
state_results
missing
pending_producers
contradictions
currentness
next_verifier
primary_frontier
input_digest
```

Currentness uses adapter-observed timestamps and source cursors already present in primary events.
Missing, malformed, or conflicting time yields `CURRENTNESS_UNPROVEN`.

## Inline diagnostics, reviewers, and join barrier

`PostToolUse` may return one bounded model-visible advisory when the ledger-backed diagnostic state
changes. `SubagentStop` is a persistence boundary, not a promised direct parent-context channel;
the next parent `PostToolUse` or `Stop` surfaces the persisted delta.

A requested reviewer records expected actor, reviewer type, exact head, and terminal verdict schema.
Two requirements cannot be satisfied by one actor unless the profile explicitly declares that
identity for both. Terminal verdicts are:

```text
CLEAN
FINDINGS
INVALID
STALE
```

A successful review job with findings is `FINDINGS`, not `CLEAN`. Free-form review prose is not a
terminal structured verdict.

The default software-release quiet barrier requires two primary samples at least 120 witnessed
seconds apart with identical profile and contract hashes, exact head, producer statuses, reviewer
actors and verdicts, checks, unresolved-thread state, source cursors, and local verifier result.
Any change restarts the barrier.

At an unsupported Stop, `diagnostic_id` is derived from contract, gate, normalized blocker set, and
primary frontier. The persisted `closeout_attempted` event records whether that diagnostic is
unchanged. Attempts one and two return `decision: "block"`; attempt three appends the generated
non-success envelope and terminal seal.

## Privacy projection

Privacy projection occurs before canonical hashing.

- `full` mode retains bounded contract and diagnostic text according to the existing redaction
  contract.
- `proof` mode withholds objective-like prose, contract text, diagnostic prose, and closeout
  narrative. It retains stable labels, state IDs, profile references, evidence references, producer
  identities, digests, and deterministic `text_withheld` markers.

Proof-mode events, capsules, receipts, handoffs, and continuation prompts must not contain the
withheld text. The retained structural fields must still permit compilation, deduplication, lineage
verification, and continuation.

## Continuation fold v2

The implementation must:

- add `v2` to `KNOWN_FOLD_VERSIONS`;
- set `CURRENT_FOLD_VERSION` to `v2` for new anchors;
- add a v2 reducer to the lineage verifier;
- keep every existing legacy fixture byte-identical;
- carry the contract, compiled state, pending producers, diagnostic state, close-attempt frontier,
  and gate samples in the v2 capsule;
- inherit an open contract as open across a window boundary;
- never reopen a sealed contract.

A later contradiction opens a successor observation run. The previous sealed packet remains an
immutable as-of result, while the successor links it by `capsule_ref` and may record
`claim_superseded`.

## Recurrence reducer

Profiles register stable `failure_class_id` values. An incident supplies a distinct incident
reference and eligible primary evidence references. The reducer reconstructs recurrence from the
validated ledgers rather than a second mutable database.

One initial incident plus two distinct confirmed recurrences emits one derived
`ENFORCEMENT_REQUIRED` obligation. Replay emits no duplicate. The reducer does not edit code,
policy, infrastructure, or deployment.

## Build order and kill gate

Before runtime code, a disposable clean-install transport spike must prove actual host behavior:

- `PostToolUse` delivers model-visible additional context;
- `Stop` can return `decision: "block"` and continue the parent;
- `SubagentStop` evidence persists for a later supported parent boundary;
- deduplication and counters survive separate hook processes.

Failure of the first two transports terminates the build as `BLOCKED_TRANSPORT`.

The four versioned slices are:

1. `0.1.33` — contract, compiler, fold v2, privacy projection, and sealed unsupported closeout.
2. `0.1.34` — inline diagnostics, named joins, quiet barrier, and successor supersession.
3. `0.1.35` — paginated GitHub evidence and registered-probe identity envelopes.
4. `0.1.36` — recurrence reducer and one enforcement obligation.

The Slice 1 kill fixture uses only `software_release/v1` vocabulary: source identity and checks are
present; deployment identity, configuration presence, registered canary, terminal effect, and
required replay are absent. It must compile exactly `BUILT`, warn inline, and refuse a higher seal.

## Acceptance and authorized merge policy

Every slice requires executable tests, mutation proof, clean Windows CI, fresh independent review
at the exact final head, zero unresolved actionable threads, and two unchanged remote-state samples
120 seconds apart. A changed head invalidates every earlier review.

Required mutations include derived self-evidence, forged production payloads, production-shaped
mocks, actor and head mismatch, pending and late-finding reviewers, decisive page-two GitHub data,
cross-process diagnostic deduplication and resolution, three cross-process Stop attempts, post-seal
append corruption, successor supersession, proof-mode text leakage, open-contract continuation,
free-form completion narration, and three distinct recurrence incidents.

Adam authorizes Codex to squash-merge exactly these five PRs when their declared gates are terminal
and clean: this ratification PR #13 and the four implementation slices. This supersedes the shipped
SPEC acceptance check that previously required the final PR to remain unmerged. It is not standing
authorization for unrelated merges, releases, package publication, deployment, credentials, or
production mutation.

PR #13 is spec-only and does not change the package version. Version bumps begin with Slice 1.

## Loop contract

```text
verifier: targeted mutation tests; npm test; npm run validate:plugin; clean-install host smoke;
          sealed/successor lineage verification; exact-head independent reviews; Windows CI
exit: VERIFIED_GREEN or 12 repair cycles or 7 days or two no-progress cycles
spend: no purchase, top-up, plan upgrade, or new paid service
irreversible effects: only the five named squash merges are pre-authorized; all others remain gated
stop if: transport fails, the compiler needs an LLM, or the build becomes an orchestration framework
```
