# Lyhna for Codex

`lyhna-codex-adapter` is the Codex-native front door for a local Lyhna witnessed run. It captures supported Codex lifecycle evidence, keeps builder and evaluator capabilities separate, binds PR examination to an exact GitHub head, and renders a coverage-scoped local receipt.

Lyhna records what was observed. It does not approve, block, certify, merge, or decide whether work is commercially, architecturally, legally, or operationally correct.

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
