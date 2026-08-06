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

1. **Closed evidence-eligibility firewall.** Only `evidence_observed` envelopes emitted through a
   registered supervisor-owned observer or probe may satisfy profile requirements. Contract,
   producer-lifecycle, close, supersession, compiler, gate, diagnostic, receipt, recurrence, and
   narration events are control/history only, even when their bytes and hashes are valid. Profiles
   cannot widen this closed eligibility matrix.
2. **Ledger-backed control state.** Close attempts, eligible-evidence frontiers, input digests, diagnostic
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

Each requirement declares an assurance class: `local`, `repository`, or `production`. In the
bundled profile, `BUILT` requirements are local, `MERGED` requirements are repository, and every
deployment/configuration/canary/terminal-effect requirement for `DEPLOYED` or `LIVE_PROVEN` is
production. A production requirement is structurally invalid unless its sole eligible origin is
`registered_probe` and it names the exact profile-authorized producer identity and subject binding.
`github_observed`, `mcp_routed`, `runtime_hook`, evaluator output, imports, and agent narration can
support their registered non-production classes but can never satisfy a production requirement.

These nodes are not a universal ladder. Other projects provide validated profiles with their own
internal prerequisite DAGs. Every profile must also declare an unambiguous ordered surface
projection. Multiple incomparable supported internal nodes are returned as
`maximal_supported_nodes`; `highest_supported_state` is populated only by the unique ordered
surface projection. A profile with an ambiguous or missing projection is rejected before use.

A profile snapshot is canonicalized as ledger-owned immutable bytes in `claim_contract_declared`.
`profile_requirements_hash`, computed only from the canonical machine-required structural
projection, is the stable profile identity used by the compiler, continuity, and recurrence in
every privacy mode. Optional display metadata has a separate `profile_display_hash` only in
`verified_context` and can never change structural identity or satisfy a requirement. In
`verified_context`, the event and v2 capsule carry the bounded, redacted display projection beside
the structural projection. In `proof`, the event payload is projected before canonical ledger
hashing: it carries the same complete structural projection and deterministic `text_withheld`
markers, never display metadata or a hash derived from that withheld text. The proof-mode v2 capsule
carries that same canonical structural projection and requirements hash. Either projection contains
everything the pure compiler needs, so deleting or editing a project profile after declaration
cannot change offline continuation or refolding. A locally declared profile states the chosen
requirements; it does not prove those requirements are sufficient.

An immutable contract contains:

```text
contract_id
profile_id and profile_requirements_hash
requested_state
declared_gate_ids
named producer IDs and expected identities
objective_ref
verifier_id
caps
run_privacy_mode_ref
recurrence_scope_ref (required only when the profile enables recurrence)
```

`run_privacy_mode_ref` is copied by the supervisor from the chained `run_begun` event. It is not
supplied or overridable by `declare_claim_contract`; an attempted privacy field is rejected by the
closed tool schema. The run-anchored mode remains the single authority.

Every compiler-retained contract value uses one closed structural schema in both `verified_context`
and `proof`. State and gate IDs must exist in the frozen profile; producer and `verifier_id` values
must exist in the registered profile registry; caps are bounded numeric/enumerated fields; and
`contract_id`, `objective_ref`, and `recurrence_scope_ref` are strict opaque references issued
independently of free text. An objective with no independent structural reference uses only
`text_withheld`, not a digest of its prose. Unknown keys, free-text verifier values, invalid opaque
refs, and text smuggled into any structural field are rejected before event hashing in either mode.
`verified_context` may retain bounded, redacted display prose in its separate non-authoritative
display projection, but display fields can never alter or substitute for the validated structural
state, gates, producers, verifier, IDs, caps, or references consumed by compiling, gating, or
continuation.

The official completion result is a generated closeout envelope. Free-form prose is neither parsed
nor accepted as completion evidence. Generated language always states profile, state, scope, and
evidence frontier and never emits the bare word "works."

## Public and supervisor interfaces

The existing ten agent-facing tools remain unchanged. The claim compiler adds exactly three tools:

```text
declare_claim_contract(session_capability, contract)
request_claim_producer(session_capability, contract_id, producer_id)
evaluate_claim_gate(session_capability, contract_id, gate_id)
```

The shipped `request_close.reason` remains narration only. It asks the supervisor to evaluate the
already declared contract when one exists. A run with no claim contract follows the shipped v1
`request_close` and Stop closure behavior unchanged: it is never compiler-blocked, never receives a
compiler terminal state, and seals under the existing evidence-scoped rules. There is no
agent-facing `submit_evidence`, `record_probe`, or contract-amendment tool. `tools/list` must retain
all ten shipped tools and expose the three additions with backward-compatible existing schemas.

The existing `claim_evaluation` interface is the issuance boundary for evaluator finding and
verdict submissions. A v2 evaluation request carries a bounded `finding_slot_cap`; on a successful
claim, the supervisor persists and returns that many child-bound finding `submission_ref` values
plus exactly one child-bound `verdict_submission_ref` in an additive structured-result field.
Legacy claims omit the field and retain their existing result shape. `record_evaluation` consumes
those refs as defined below; no hook is expected to inject an argument after the child constructs
the call.

Evidence enters through supervisor-owned hooks, the GitHub observer, or registered project probe
adapters. A producer request is not evidence.

## Ledger event contract

Ledger event families are classified independently of their hash-chain integrity. Control/history
events are never requirement-eligible:

```text
claim_contract_declared
producer_requested
producer_terminal
evaluation_submission_issued
evaluation_submission_consumed
evaluation_verdict_submitted
continuation_lease_transferred
gate_sample_observed
closeout_attempted
claim_superseded
```

The only requirement-eligible family is:

```text
evidence_observed
```

An eligible envelope must have an event kind from the closed observer/probe registry, an allowed
origin, a registered producer identity, the profile-required identity bindings, and a source
cursor. `agent_reported`, `evaluator_reported`, `producer_requested`, `producer_terminal`,
`evaluation_submission_issued`, `evaluation_submission_consumed`,
`evaluation_verdict_submitted`, `gate_sample_observed`, `continuation_lease_transferred`,
`closeout_attempted`, and `claim_superseded` never satisfy a requirement.
Reviewer conclusions become eligible only through an `evidence_observed` envelope bound to a
separately sealed evaluator child receipt; evaluator narration alone remains ineligible.

Derived, permanently non-evidentiary event families:

```text
claim_compiled
gate_evaluated
diagnostic_emitted
diagnostic_resolved
closeout_envelope_generated
enforcement_required
```

Every claim-scoped derived event carries `claim_contract_ref`, `fold_version`, `input_digest`, the eligible
evidence frontier, and the material-control frontier it summarized. The eligible frontier is the
canonical digest of requirement-eligible `evidence_observed` projections only and alone can support
a requirement. The material-control frontier covers the contract, producer requests and terminal
states, gate samples, and current successor dispositions because they affect pending producers,
currentness, blockers, or the quiet barrier. `closeout_attempted`, diagnostic, envelope, and other
derived/history events are excluded from both compiler frontiers. `input_digest` commits to the
profile/contract plus both frontiers, so a new requested reviewer or gate sample recomputes state
without laundering that control event into evidence. Unchanged input does not append another
compile result, diagnostic, or resolution.

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

Profiles choose only from the closed eligible observer/probe registry and name accepted origins,
producer identities, and identity bindings for every requirement. Profile validation rejects any
requirement that names a control/history or derived event family. `mock_or_test` can exercise logic
but cannot satisfy production requirements. An agent-reported payload marked production remains
agent-reported and ineligible. A production-class requirement additionally rejects every origin
except `registered_probe` and every producer other than its exact profile-authorized identity.

## Deterministic compiler output

The pure compiler returns:

```text
contract_id
profile_ref
requested_state
highest_supported_state
maximal_supported_nodes
state_results
missing
pending_producers
contradictions
currentness
next_verifier
eligible_evidence_frontier
material_control_frontier
input_digest
```

Currentness uses adapter-observed timestamps and source cursors already present in primary events.
Missing, malformed, or conflicting time yields `CURRENTNESS_UNPROVEN`.

## Inline diagnostics, reviewers, and join barrier

`PostToolUse` may return one bounded model-visible advisory when the ledger-backed diagnostic state
changes. `SubagentStop` is a persistence boundary, not a promised direct parent-context channel;
the next parent `PostToolUse` or `Stop` surfaces the persisted delta.

A requested reviewer records expected actor, reviewer type, exact head, and terminal verdict
schema. Its actor and hook-issued child capability must differ from the builder/parent. An eligible
review envelope must bind to a separately sealed child receipt containing the frozen head, detached
checkout evidence, clean tracked tree before and after, bounded redacted check names/statuses with
evidence hashes or references, and terminal verdict. Full commands, arguments, output, environment,
tokens, and private paths are never stored. A builder-attributed verdict, same-capability review,
attached checkout, dirty checkout, or head mismatch is `INVALID` and cannot satisfy a gate. Two
requirements cannot be satisfied by
one actor unless the profile explicitly declares that identity for both. Terminal verdicts are:

```text
CLEAN
FINDINGS
INVALID
STALE
```

A successful review job with findings is `FINDINGS`, not `CLEAN`. Free-form review prose is not a
terminal structured verdict.

The shipped `record_evaluation(..., finding, ...)` input remains accepted for compatibility, with
optional backward-compatible structured `severity`, finding-count, and `submission_ref` fields. For
v2 claim-compiler evaluator findings, `submission_ref` is required and must be the opaque stable ref
issued and returned to that child by `claim_evaluation`. The evaluation request declares a bounded
finding-slot cap; claiming it appends one `evaluation_submission_issued` control event per slot,
derived from the evaluation-request ref and slot ordinal, and returns those opaque refs only to the
bound child. Issuance is persisted before return. `record_evaluation` atomically consumes one ref by
appending `evaluation_submission_consumed` with the resulting finding ID; an agent-chosen, unknown,
wrong-evaluation, or wrong-child ref is rejected. Replaying a consumed ref ignores the new payload
and returns the prior finding ID and structured result without another append, while a legitimate
second finding uses a distinct issued slot. Unused slots prove nothing and expire at the earlier of
atomic verdict acceptance or child-receipt sealing. The string finding is human-authored prose: the
store writes only a bounded redacted
summary plus a supervisor-generated finding ID derived at
write time from the evaluator-request event ref, frozen head, review type, and `submission_ref`,
never from the prose or a future receipt. Severity uses a closed enum and defaults to `UNSPECIFIED`;
count is validated against the structured findings or deterministically calculated. It never
stores full commands, output, tokens, environment, or private paths embedded in the input. In
`proof`, the finding summary is projected away; finding ID, severity/count, verdict, and evidence
references remain. When the child seals, its terminal event binds those existing finding IDs to the
sealed evaluator receipt ref; no ID is rewritten.

The same backward-compatible `record_evaluation` schema accepts an optional structured `verdict`
with the issued `verdict_submission_ref`. Its closed v2 request union has exactly two mutually
exclusive variants: a finding submission identified by its finding `submission_ref`, or a verdict
submission identified by its `verdict_submission_ref`. A verdict submission must omit the prose
`finding` field and every finding-variant field; a call carrying both discriminants or any fields
from both variants is rejected before consuming a finding slot or verdict ref and appends nothing.
Legacy calls containing only the shipped finding fields remain unchanged. Verdict consumption runs
under the evaluation's run lock and atomically appends one
`evaluation_verdict_submitted` control event, bound to the evaluation request, child capability,
exact head, review type, and closed verdict enum, while expiring every still-unused finding slot for
that evaluation. `CLEAN` is accepted only when zero finding slots have been consumed at that atomic
point. `FINDINGS` requires at least one consumed finding ID. After any verdict wins, every later
finding submission is rejected, except that replay of a slot consumed before the verdict returns its
prior structured result without another append. The verdict-versus-finding race therefore has one
deterministic serialized winner and can never produce a clean verdict followed by a new finding.
`INVALID` and `STALE` carry their structural reason code and refs. Replaying the verdict ref returns
the prior structured result without another append; a different or second verdict ref is rejected.
If `SubagentStop` occurs before a valid verdict submission, the producer terminates `INVALID` with
`VERDICT_MISSING`; absence of findings is never interpreted as `CLEAN`. Child sealing then binds the
submitted verdict and finding IDs to the sealed evaluator receipt.

The default software-release quiet barrier requires two primary samples at least 120 witnessed
seconds apart with identical profile-requirements and contract hashes, exact head, producer statuses, reviewer
actors and verdicts, checks, unresolved-thread state, source cursors, pagination-completeness
markers, and local verifier result. GitHub checks, reviews, comments, and unresolved threads are
terminal only after every page is observed and the final cursor or explicit end marker is bound
into the sample. A truncated page set, missing final cursor, or cursor change is `INVALID` or
`STALE`, never clean. Any change restarts the barrier.

At an unsupported Stop, `blocker_fingerprint` is derived from contract, gate, normalized blocker
set, and the eligible evidence frontier. A producer or gate control transition that changes the
effective normalized blocker set changes the fingerprint and resets the ordinal even when eligible
evidence is unchanged. Control chatter that leaves the effective blocker set unchanged, plus
self-generated close attempts and derived events, never changes it. The persisted
`closeout_attempted` event records that fingerprint and the next ordinal for its uninterrupted
occurrence. Attempts one and two return `decision: "block"`; attempt three appends the generated
non-success envelope and terminal seal. A changed eligible evidence frontier also recomputes the
blocker set and resulting fingerprint.

## Privacy projection

The canonical privacy enum remains the shipped `verified_context | proof`.

The selected value comes only from `begin_run` and its chained `run_begun` event. Contract
declaration inherits that value by reference and cannot change it.

- `verified_context` retains bounded, redacted contract, profile-display, diagnostic,
  evaluator-finding, objective, and closeout text for the owner.
- `proof` is an at-write guarantee for every event appended by a v2 writer, including existing event
  types such as `run_begun` and evaluator findings as well as newly introduced families. Before
  canonical event hashing, objective-like prose, contract text, profile display metadata,
  diagnostic prose, evaluator finding prose, and closeout narrative are replaced with stable
  structural fields and deterministic `text_withheld` markers. The raw prose and any digest derived
  from it never enter the proof-mode ledger. Capsule, receipt, handoff, continuation prompt, and
  exported packet are then folded only from that already-projected chain. Stable labels, state IDs,
  the privacy-safe structural profile projection, evidence references, producer identities, and
  control digests remain.

The v2 proof projection registry is closed, versioned, and exhaustive for text-bearing event fields:

| Event field | `verified_context` | `proof` before event hashing |
|---|---|---|
| `run_begun.objective_text` and objective-like request text | bounded redacted text plus its local text hash | omit text and every prose-derived hash; retain only an independently supplied structural `objective_ref`, when present, plus `text_withheld` |
| `builder_claim.statement` / `statement_text` / prose-derived `statement_ref` | bounded redacted text plus local text hash | omit all three; retain origin, evidence refs, state labels not derived from narration, plus `text_withheld` |
| `claim_contract_declared` contract prose and profile display metadata | bounded redacted projection | structural contract/profile fields plus `text_withheld` |
| evaluator-finding summary | bounded redacted summary | finding ID, severity/count, refs, plus `text_withheld` |
| diagnostic prose | bounded redacted prose | diagnostic ID/status/refs plus `text_withheld` |
| closeout narrative | bounded redacted narrative | profile/state/scope/frontiers plus `text_withheld` |

A v2 writer rejects any unregistered event type or text-bearing field before append; it never
passes an unknown field through. This table governs existing event names as well as new families.

Proof-mode events and exported artifacts must not contain the withheld text. This v2 at-write rule
does not rewrite or change the bytes of any legacy v1 event, ledger, fixture, or receipt. The v2
anchor seals the selected privacy mode, and the retained structural fields must still permit
compilation, deduplication, lineage verification, and continuation.

## Continuation fold v2

The implementation must:

- add `v2` to `KNOWN_FOLD_VERSIONS`;
- set `CURRENT_FOLD_VERSION` to `v2` for new anchors;
- add a v2 reducer to the lineage verifier;
- keep every existing legacy fixture byte-identical;
- carry the mode-appropriate full or structural profile projection, contract, compiled state,
  pending producers, diagnostic state, close-attempt frontier, gate samples, and unresolved
  enforcement-obligation references in the v2 capsule;
- inherit an open contract as open across a window boundary;
- never reopen a sealed contract.

Open-contract window continuation rotates the lease on the same run and ledger; it never creates two
writable histories or a second contract declaration. Under a data-root continuation lock plus the
predecessor run lock, `begin_run(..., continues_from: capsule_ref)` must validate that the open
capsule is the current published face, re-walk its chain, and reconstruct the complete immutable
contract and control state. The capsule includes the canonical structural profile projection and
`profile_requirements_hash`, optional mode-allowed display projection/hash, contract ID,
`objective_ref`, requested state, gate IDs, producer identities, `verifier_id`, caps,
`run_privacy_mode_ref`, `recurrence_scope_ref`, compiled state, pending producer cursors, unresolved
diagnostics and resolutions, blocker fingerprint and close-attempt ordinal, quiet-period samples,
gate-sample cursors, and unresolved enforcement refs.

The supervisor then appends one `continuation_lease_transferred` control event to that same open
ledger. Under the same transaction it revokes the predecessor parent-session capability, binds the
new hook-observed parent session, and migrates every already-registered active child lifecycle route
to the new run lease without changing that child's capability, child ID, evaluation request, issued
slots, or expected terminal binding. The old parent capability can perform no general hook or MCP
write and cannot start a new child after transfer. A terminal lifecycle hook from a migrated active
child remains admissible exactly once through its existing child capability and appends to the same
run; replay returns the prior terminal result without a duplicate append. All other writes using the
revoked parent capability are rejected. The new session reconstructs from the ledger before its
first work boundary, so compiler state, diagnostics, attempts, joins, quiet samples, active children,
scope, and gate enforcement continue without reset. The run's sole `claim_contract_declared` event
remains authoritative and a second declaration is rejected. If the capsule is stale, any
contract/control field fails equality, the predecessor is not locally available, the active-child
route set cannot be migrated completely, or revocation, migration, and transfer cannot be committed
atomically, continuation fails closed and no second writable run is opened.

A later contradiction does not open a run automatically. After a new explicit Lyhna invocation,
the shipped `begin_run(..., continues_from: capsule_ref)` path opens the successor. The previous
sealed packet remains an immutable as-of result, while the successor links it by `capsule_ref` and
may record `claim_superseded`. That event must carry `supersedes_ref` identifying the exact prior
claim or closeout envelope plus the already validated predecessor `capsule_ref`; the reducer rejects
a missing reference, a reference outside that capsule, or a reference that does not hash to the
named prior record. Post-seal activity without explicit invocation creates no Lyhna run.

## Recurrence reducer

Profiles register stable failure entries containing `failure_class_id` and a closed structural
`required_verifier_id`. A recurrence-enabled contract also declares a
stable structural `recurrence_scope_ref` for the project or work domain; free-form objective text
cannot supply it. A counted incident is an `evidence_observed` envelope from the profile-registered
incident observer or probe, carrying the authorized observation producer identity, source cursor,
failure class, and stable incident-subject/occurrence reference required by that profile. The
producer identity, cursor, evidence refs, run, and ledger tip bind provenance and eligibility but are
excluded from occurrence identity. The supervisor derives `incident_ref` only from the canonical
structural tuple `(profile_requirements_hash, recurrence_scope_ref, failure_class_id,
stable_incident_subject_or_occurrence_ref)`; neither the agent nor an imported narrative may choose
it. Re-observing the same source occurrence through another authorized producer, cursor, evidence
envelope, or run therefore produces the same `incident_ref` and counts once, while a distinct stable
occurrence reference produces a distinct incident and a missing or conflicting occurrence identity
is ineligible. The reducer reconstructs recurrence from validated ledgers rather than a second mutable
database. Its immutable aggregate input is the canonical sort of unique records containing
`profile_requirements_hash`, `recurrence_scope_ref`, `failure_class_id`, `incident_ref`,
`source_run_id`, `source_contract_ref`, `source_ledger_tip`, and eligible evidence references. The
`recurrence_frontier` is the digest of those sorted records.

When one initial incident plus two distinct confirmed recurrences are first observed, the
destination is eligible only if the current explicitly invoked open contract declares the same
`profile_requirements_hash` and `recurrence_scope_ref` and its profile registers that exact
`failure_class_id`. The reducer must append exactly one derived `ENFORCEMENT_REQUIRED` obligation
to that eligible run. It carries the failure class, its profile-bound `required_verifier_id`,
`recurrence_frontier`, sorted incident/contract refs, and per-ledger tips instead of a single
`claim_contract_ref`. Proof projection and v2 continuation retain that verifier ID beside the
unresolved obligation ref. No source ledger is modified, and a sealed current run cannot receive
it. The supervisor snapshots two canonical sorted sets from the complete local open-and-sealed run
index for the exact tuple `profile_requirements_hash`, `recurrence_scope_ref`, and
`failure_class_id`: incident candidates and obligation candidates, including open runs that have
never produced a Stop capsule. Each open candidate is identified by its validated ledger tip and
event count at snapshot time; a prefix is immutable input only for that reduction, not a claim that
the open ledger is terminal. Only distinct eligible incidents in that tuple are counted and
included in its `recurrence_frontier`; other classes, profiles, or scopes cannot affect its threshold
or digest. The supervisor independently verifies and re-walks every candidate ledger in both sets.
The entire scan, verification, re-sample, duplicate check, and destination append executes under a
data-root-wide recurrence/index lock, not the shipped per-run writer lock. Per-run locks are acquired
inside it in canonical run-ID order. Before append the reducer re-samples both tuple-scoped sets,
including every open event count and tip, and proceeds only if their membership and ledger tips are
unchanged; otherwise it releases and retries from a new snapshot. This serializes two eligible
destination runs so only the first can append. Before append,
it searches the complete verified obligation set for an existing obligation with the same tuple;
the tuple may have at most one durable obligation and is its stable idempotency key. When the
threshold is first observed in an eligible open run and no such obligation exists, omission is an
error rather than an allowed outcome. The event records the threshold-crossing recurrence frontier.
Replay, an unrelated scope/profile/class, or a fourth and
later incident cannot
silently suppress or duplicate the obligation: unrelated tuples reduce separately, while the same
tuple reports its existing obligation and newer incident set read-only. An unresolved obligation
ref is carried in v2 continuation until an explicit future disposition contract resolves it. With
no tuple-matching eligible open run, the reducer reports the obligation read-only and appends
nothing; it never attaches an obligation to an unrelated active run. It never edits code, policy,
infrastructure, or deployment.

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
3. `0.1.35` — terminally paginated GitHub evidence and registered-probe identity envelopes.
4. `0.1.36` — recurrence reducer and one enforcement obligation.

The Slice 1 kill fixture uses only `software_release/v1` vocabulary: source identity and checks are
present; deployment identity, configuration presence, registered canary, terminal effect, and
required replay are absent. It must compile exactly `BUILT`, warn inline, and refuse a higher seal.

## Acceptance and authorized merge policy

PR #13 and every implementation slice require executable tests, mutation proof where runtime code
exists, clean Windows CI, fresh independent review at the exact final head, zero unresolved
actionable threads, and two unchanged remote-state samples 120 seconds apart. A changed head
invalidates every earlier review. PR #13's gate mapping is repository
`Lyhna-ai/lyhna-codex-adapter`, PR `13`, base `main`, change class `spec_ratification`, branch
`claude/gatea-witnesslane-reconcile-1zlfsb`, exact reviewed head recorded immediately before merge,
and package version unchanged at `0.1.32`.

Required mutations include identical closed structural contract validation in `verified_context`
and `proof`, including rejection in both modes of an invalid state or gate, an unregistered producer
or verifier, and an invalid scope reference; derived self-evidence, a profile attempting to accept a control event,
forged control events and production payloads, production-shaped mocks, rejection of
`github_observed`/`mcp_routed` production evidence and wrong registered-probe identities,
builder/same-capability/
attached-checkout review, actor and head mismatch, pending and late-finding reviewers, decisive
page-two GitHub data, truncated pagination and missing final cursors, a diamond profile with
ambiguous surface projection, deletion of a declared custom profile, cross-process diagnostic
deduplication and resolution, persisted host-issued evaluator submission slots, wrong-child/ref
rejection, write-time prose-independent finding IDs, sealed-receipt binding, legitimate
duplicate-text findings, consumed-slot replay deduplication, structured `CLEAN` and `FINDINGS`
verdict submissions, atomic expiration of all unused finding slots at verdict acceptance, a
serialized `CLEAN`-versus-finding race with exactly one winner and no post-verdict finding,
rejection without append of a single call carrying both finding and verdict variants, verdict
replay, and `VERDICT_MISSING` on silent child Stop,
three cross-process Stop
attempts with one stable blocker fingerprint, eligible evidence resetting that fingerprint,
material control changing compiler state without satisfying evidence, evaluator command/argument
or finding-prose leakage, recurrence across three sealed source ledgers with no post-seal append,
privacy-independent structural profile identity, per-failure-class recurrence thresholds,
supervisor-derived incident identity, suppression of the same stable occurrence observed under a
different authorized producer, cursor, envelope, or run, distinct counting for a different stable
occurrence, cross-run duplicate-incident suppression, and propagation of
the profile-bound `required_verifier_id` into obligation and continuation,
recurrence-scope and destination-contract separation, atomic incident/obligation set resampling
including open incident and obligation runs before their first Stop, concurrent promotion
deduplication under a data-root-wide lock with two eligible destination runs, mandatory
threshold promotion only into a tuple-matching open contract,
fourth-incident and replay deduplication, post-seal append corruption, exact-reference successor
supersession and invalid
supersession rejection, proof-mode removal of objective/statement text and prose-derived refs from
`run_begun` and `builder_claim`, projection of evaluator findings and every other existing or new
v2-writer event type plus profile/display and downstream artifact leakage, unknown text-field
rejection, proof-mode prose smuggling through `objective_ref`, `verifier_id`, caps, or other
structural contract fields, open-contract same-run lease rotation with complete contract/control reconstruction,
stale or unavailable predecessor rejection, atomic migration of a pending child's lifecycle route,
single acceptance of that child's post-transfer `SubagentStop`, no duplicate terminal append,
revoked-parent write and new-child rejection, inherited
diagnostics, attempts, producers, quiet samples, immediate gate enforcement, and second-declaration
rejection, no-contract v1 close compatibility,
free-form completion narration,
full backward-compatible `tools/list`,
privacy-mode override rejection, and three distinct recurrence incidents.

Adam authorizes Codex to squash-merge this ratification PR #13 and four future slices only when
their declared gates are terminal and clean. The future targets are fixed as repository
`Lyhna-ai/lyhna-codex-adapter`, base `main`, and branches:

```text
codex/claim-compiler-contract   -> Slice 1 / 0.1.33
codex/claim-compiler-join       -> Slice 2 / 0.1.34
codex/claim-compiler-evidence   -> Slice 3 / 0.1.35
codex/claim-compiler-recurrence -> Slice 4 / 0.1.36
```

Before each merge, the coordinator records a gate mapping containing repository, PR number, base,
slice ID, branch, exact reviewed head, expected version, and this authorization reference. A
mismatch, missing mapping, or changed head blocks the merge. This supersedes the shipped SPEC
acceptance check that previously required the final PR to remain unmerged. It is not standing
authorization for unrelated merges, releases, package publication, deployment, credentials, or
production mutation.

PR #13 is spec-only and does not change the package version. Version bumps begin with Slice 1.

## Loop contract

PR #13 exhausted its original twelve-cycle cap at head `2a3a75b`. Adam authorized exactly one
non-renewing extension repair cycle, limited to: stable recurrence incident identity, active-child
continuation routing, atomic verdict/finding-slot closure, and privacy-independent structural
contract validation. After that edit, every exact-head gate reruns. Any remaining or new actionable
finding ends PR #13 as `CAP_REACHED`; it does not authorize a fourteenth repair.

After exact-head review of that extension, Adam authorized exactly one final repair at predecessor
head `b5108ee`, limited solely to rejecting a combined finding-plus-verdict submission before any
slot/ref consumption or append. This ruling supersedes only the exhausted-cycle sentence above for
that one defect. Any other content change, remaining actionable finding, or new actionable finding
exhausts the final authorization and leaves PR #13 unmerged.

Implementation slices start with fresh, independent, non-transferable repair budgets: Slice 1 has
eight completed repair cycles, Slice 2 has six, Slice 3 has six, and Slice 4 has four. Each slice
starts at zero only on its fixed branch and cannot borrow unused cycles from another slice. Each also
retains a six-active-hour wall cap, a two-consecutive-no-new-evidence cap, and the no-paid-upgrade
spend rule. Hitting a slice cap terminates that slice honestly; it does not reopen PR #13 or expand
scope.

```text
verifier: targeted mutation tests; npm test; npm run validate:plugin; clean-install host smoke;
          sealed/successor lineage verification; exact-head independent reviews; Windows CI
PR #13 exit: VERIFIED_GREEN or its final combined-payload repair cycle is exhausted
slice exits: VERIFIED_GREEN or its independent 8 / 6 / 6 / 4 repair cap, six active hours,
             or two consecutive completed cycles with no new evidence
overall exit: VERIFIED_GREEN or 7 days
spend: no purchase, top-up, plan upgrade, or new paid service
irreversible effects: only the five named squash merges are pre-authorized; all others remain gated
stop if: transport fails, the compiler needs an LLM, or the build becomes an orchestration framework
```
