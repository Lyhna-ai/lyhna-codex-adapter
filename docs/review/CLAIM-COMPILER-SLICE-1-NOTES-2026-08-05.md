# Claim compiler Slice 1 clarifications — 2026-08-05

These implementation choices close the non-blocking residuals recorded after ratification without
changing the ratified product boundary.

- A closeout attempt ordinal counts the maximal **contiguous** occurrence of one blocker
  fingerprint. `A → B → A` therefore records `A1, B1, A1`; it does not resume the earlier A streak.
- The supervisor assigns every builder claim a run-scoped identifier from the run ID, event family,
  and ledger-backed ordinal. Proof mode retains that identifier and ordinal while withholding all
  prose and prose-derived hashes before canonical hashing.
- The transport spike is conjunctive. Failure of PostToolUse visibility, Stop continuation,
  SubagentStop persistence/later delivery, cross-process state, or restart deduplication terminates
  the slice as `BLOCKED_TRANSPORT`.

Known limitations carried forward deliberately:

- A materially changing blocker frontier can keep a run open because the unchanged-attempt cap
  restarts. This is a liveness limitation, not permission to seal above the evidence ceiling.
- The bundled profile is locally registered. Local hash integrity and a profile's own producer
  allowlist do not establish who was authorized to register that profile or probe. Registration
  provenance is a post-0.1.37 trust-root problem, not something Slice 1 claims to solve.
- Slice 1 compiles evidence and persists producer requests, but it does not require every named
  producer to have been requested and terminal before a supported seal. Exact producer joins,
  findings-aware terminal verdicts, and the two-sample quiet barrier are Slice 2 gates.
