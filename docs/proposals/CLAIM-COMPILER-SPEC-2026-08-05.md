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

These nodes are not a universal ladder. Other projects provide validated profiles with their own
internal prerequisite DAGs. Every profile must also declare an unambiguous ordered surface
projection. Multiple incomparable supported internal nodes are returned as
`maximal_supported_nodes`; `highest_supported_state` is populated only by the unique ordered
surface projection. A profile with an ambiguous or missing projection is rejected before use.

A profile snapshot is canonicalized as ledger-owned immutable bytes in `claim_contract_declared`;
its mode-appropriate canonical hash is the profile identity. The schema separates machine-required
structural fields from optional human-authored display metadata. In `verified_context`, the event
and v2 capsule carry the full bounded, redacted canonical snapshot. In `proof`, the event payload is
projected before canonical ledger hashing: it carries the complete structural projection and
deterministic `text_withheld` markers, never display metadata or a hash derived from that withheld
text. The proof-mode v2 capsule carries that same canonical structural projection and hash. Either
projection contains everything the pure compiler needs, so deleting or editing a project profile
after declaration cannot change offline continuation or refolding. A locally declared profile
states the chosen requirements; it does not prove those requirements are sufficient.

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
run_privacy_mode_ref
recurrence_scope_ref (required only when the profile enables recurrence)
```

`run_privacy_mode_ref` is copied by the supervisor from the chained `run_begun` event. It is not
supplied or overridable by `declare_claim_contract`; an attempted privacy field is rejected by the
closed tool schema. The run-anchored mode remains the single authority.

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

Evidence enters through supervisor-owned hooks, the GitHub observer, or registered project probe
adapters. A producer request is not evidence.

## Ledger event contract

Ledger event families are classified independently of their hash-chain integrity. Control/history
events are never requirement-eligible:

```text
claim_contract_declared
producer_requested
producer_terminal
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
`gate_sample_observed`, `closeout_attempted`, and `claim_superseded` never satisfy a requirement.
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
agent-reported and ineligible.

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
optional backward-compatible structured `severity` and finding-count fields. The store treats the
string finding as human-authored prose: it writes only a bounded redacted finding summary plus a
supervisor-generated finding ID derived from the sealed evaluator receipt reference and finding
ordinal, never from the prose. Severity uses a closed enum and defaults to `UNSPECIFIED`; count is
validated against the structured findings or deterministically calculated. It never stores full
commands, output, tokens, environment, or private paths embedded in the input. In `proof`, the
finding summary is projected away; finding ID, severity/count, verdict, and evidence references
remain. Replay of the same sealed receipt and ordinal resolves to the same ID and appends no
duplicate.

The default software-release quiet barrier requires two primary samples at least 120 witnessed
seconds apart with identical profile and contract hashes, exact head, producer statuses, reviewer
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
- `proof` is an at-write guarantee for every new v2 event family. Before canonical event hashing,
  objective-like prose, contract text, profile display metadata, diagnostic prose, evaluator
  finding prose, and closeout narrative are replaced with stable structural fields and
  deterministic `text_withheld` markers. The raw prose and any digest derived from it never enter
  the proof-mode ledger. Capsule, receipt, handoff, continuation prompt, and exported packet are
  then folded only from that already-projected chain. Stable labels, state IDs, the privacy-safe
  structural profile projection, evidence references, producer identities, and control digests
  remain.

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

Open-contract inheritance is a supervisor transition, not a second agent declaration. After
`begin_run(..., continues_from: capsule_ref)` validates an open predecessor capsule, the supervisor
appends one `claim_contract_declared` event with `declaration_kind: inherited`, the original
contract ID and mode-appropriate profile hash, the unchanged requested state, gates, producer
identities, verifier, and caps, plus `inherited_from_contract_ref` and the validated `capsule_ref`.
The same event carries a canonical `inherited_control_state` projection copied from the verified v2
capsule: compiled state, pending producer cursors, unresolved diagnostic IDs and resolutions,
blocker fingerprint and close-attempt ordinal, quiet-period samples, gate-sample cursors, and
unresolved enforcement refs. The successor reducer initializes from that ledger event before any
new hook boundary, so process or window changes cannot reset diagnostics, attempts, joins, or quiet
samples. That event activates compilation and gate enforcement immediately and consumes the run's
sole declaration slot, so a later `declare_claim_contract` call is rejected. If either contract or
control state cannot be reconstructed and verified from the capsule, successor creation fails
closed instead of opening an unenforced or reset contract.

A later contradiction does not open a run automatically. After a new explicit Lyhna invocation,
the shipped `begin_run(..., continues_from: capsule_ref)` path opens the successor. The previous
sealed packet remains an immutable as-of result, while the successor links it by `capsule_ref` and
may record `claim_superseded`. That event must carry `supersedes_ref` identifying the exact prior
claim or closeout envelope plus the already validated predecessor `capsule_ref`; the reducer rejects
a missing reference, a reference outside that capsule, or a reference that does not hash to the
named prior record. Post-seal activity without explicit invocation creates no Lyhna run.

## Recurrence reducer

Profiles register stable `failure_class_id` values. A recurrence-enabled contract also declares a
stable structural `recurrence_scope_ref` for the project or work domain; free-form objective text
cannot supply it. An incident supplies a distinct incident reference and eligible evidence
references. The reducer reconstructs recurrence from validated ledgers rather than a second mutable
database. Its immutable aggregate input is the canonical sort of unique records containing
`profile_hash`, `recurrence_scope_ref`, `failure_class_id`, `incident_ref`, `source_run_id`,
`source_contract_ref`, `source_ledger_tip`, and eligible evidence references. The
`recurrence_frontier` is the digest of those sorted records.

One initial incident plus two distinct confirmed recurrences may append one derived
`ENFORCEMENT_REQUIRED` obligation only to the current explicitly invoked open run. It carries the
failure class, `recurrence_frontier`, sorted incident/contract refs, and per-ledger tips instead of a
single `claim_contract_ref`. No source ledger is modified, and a sealed current run cannot receive
it. The supervisor snapshots a canonical sorted candidate set from the local capsule index for the
same `profile_hash` and `recurrence_scope_ref`, then independently verifies and re-walks every
candidate ledger. Under the store's single-writer lock it re-samples that index and appends only if
the candidate set and ledger tips are unchanged; otherwise it retries from a new snapshot. Before
append, it searches that complete verified set for an existing obligation with the same
`profile_hash`, `recurrence_scope_ref`, and `failure_class_id`; that tuple may have at most one
durable obligation and is its stable idempotency key. The event records the threshold-crossing
recurrence frontier. Replay, an unrelated scope/profile, or a fourth and later incident cannot
silently suppress or duplicate the obligation: unrelated tuples reduce separately, while the same
tuple reports its existing obligation and newer incident set read-only. An unresolved obligation
ref is carried in v2 continuation until an explicit future disposition contract resolves it. With
no open run, the reducer reports the obligation read-only and appends nothing. It never edits code,
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

Required mutations include derived self-evidence, a profile attempting to accept a control event,
forged control events and production payloads, production-shaped mocks, builder/same-capability/
attached-checkout review, actor and head mismatch, pending and late-finding reviewers, decisive
page-two GitHub data, truncated pagination and missing final cursors, a diamond profile with
ambiguous surface projection, deletion of a declared custom profile, cross-process diagnostic
deduplication and resolution, prose-independent evaluator finding IDs and replay deduplication,
three cross-process Stop
attempts with one stable blocker fingerprint, eligible evidence resetting that fingerprint,
material control changing compiler state without satisfying evidence, evaluator command/argument
or finding-prose leakage, recurrence across three sealed source ledgers with no post-seal append,
recurrence-scope separation and atomic candidate-set resampling, fourth-incident and replay
deduplication, post-seal append corruption, exact-reference successor supersession and invalid
supersession rejection, proof-mode event/profile/display and downstream artifact leakage,
open-contract continuation with inherited diagnostics, attempts, producers, quiet samples,
immediate gate enforcement, and second-declaration rejection, no-contract v1 close compatibility,
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

```text
verifier: targeted mutation tests; npm test; npm run validate:plugin; clean-install host smoke;
          sealed/successor lineage verification; exact-head independent reviews; Windows CI
exit: VERIFIED_GREEN or 12 repair cycles or 7 days or two no-progress cycles
spend: no purchase, top-up, plan upgrade, or new paid service
irreversible effects: only the five named squash merges are pre-authorized; all others remain gated
stop if: transport fails, the compiler needs an LLM, or the build becomes an orchestration framework
```
