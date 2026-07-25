# Lyhna for Codex

`lyhna-codex-adapter` is the Codex-native front door for a local Lyhna witnessed run. It captures supported Codex lifecycle evidence, keeps builder and evaluator capabilities separate, binds PR examination to an exact GitHub head, and renders a coverage-scoped local receipt.

Lyhna records what was observed. It does not approve, block, certify, merge, or decide whether work is commercially, architecturally, legally, or operationally correct.

## Handing off between context windows

Long work outlives one context window, and the handoff between windows is normally a document the outgoing agent writes about itself. It drifts, and across four or five windows the thread stops describing the same project.

Every Stop writes `HANDOFF.md` and `continuation.json` into the run packet, folded from the hash-chained ledger by the supervisor hook path rather than authored by the agent. The next window opens with `begin_run(..., continues_from: <capsule_ref>)`, which seals the inheritance edge into its own chain. A human can then check the whole chain cold:

```powershell
npm run verify:lineage -- <prior-run-dir> <current-run-dir> [...more]
```

Claims carried forward are labeled against the record — `SUPPORTED`, `UNSUPPORTED`, or `UNRESOLVED_EVIDENCE` — and the claim text is retained, so the next window sees *which* claim was unsupported, not just how many. Pass `privacy_mode: "proof"` at `begin_run` when a packet is meant to leave your machine: it projects claim text out while keeping every support label and evidence reference. See [SPEC.md](./SPEC.md#continuation-and-lineage-across-context-windows).

## Install from this checkout

```powershell
codex plugin marketplace add C:\dev\lyhna-codex-adapter
codex plugin add lyhna-codex-adapter@lyhna-ai
```

Restart Codex after installation, review and trust the Lyhna hook definition once in `/hooks`, then invoke the bundled `lyhna` skill explicitly. Installation alone does not witness unrelated tasks. Lyhna introduces no new credential system; PR snapshotting reuses the user's existing GitHub CLI authentication.

## Verify

```powershell
npm test
npm run validate:plugin
```

Runtime evidence defaults to `%USERPROFILE%\.lyhna\codex-adapter`. Set `LYHNA_CODEX_DATA` to isolate a test or disposable run.

See [SPEC.md](./SPEC.md) for the accepted v0 behavior and honesty boundaries.
