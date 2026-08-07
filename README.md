# Lyhna for Codex

`lyhna-codex-adapter` is the Codex-native front door for a local Lyhna witnessed run. It captures supported Codex lifecycle evidence, keeps builder and evaluator capabilities separate, binds PR examination to an exact GitHub head, and renders a coverage-scoped local receipt.

Lyhna records what was observed. It does not approve, block, certify, merge, or decide whether work is commercially, architecturally, legally, or operationally correct.

## Plugin package format

The plugin now carries an Agent Plugins 1.0.0 portable core and a current Codex compatibility layer:

- `plugins/lyhna/plugin.json` is the portable root manifest.
- `plugins/lyhna/skills/` contains the Agent Skill.
- `plugins/lyhna/mcp.json` is the portable MCP configuration and stores state in `${PLUGIN_DATA}`.
- `plugins/lyhna/ai.lyhna.codex/` contains Codex-specific lifecycle hooks under a reverse-domain extension namespace.
- `plugins/lyhna/.codex-plugin/plugin.json`, `.mcp.json`, and the default `hooks/` bridge remain the compatibility entrypoints required by the current Codex loader.

Portable clients can discover the Agent Skill and MCP server while ignoring the Codex compatibility files and extension. The complete witnessed-run flow remains Codex-specific because it depends on Codex lifecycle hooks and hook-issued capabilities. Current Codex loads the compatibility manifest, which points at the same skill, server implementation, and namespaced hook entrypoint.

## Handing off between context windows

Long work outlives one context window, and the handoff between windows is normally a document the outgoing agent writes about itself. It drifts, and across four or five windows the thread stops describing the same project.

Every Stop writes `HANDOFF.md` and `continuation.json` into the run packet, folded from the hash-chained ledger by the supervisor hook path rather than authored by the agent. The next window opens with `begin_run(..., continues_from: <capsule_ref>)`, which seals the inheritance edge into its own chain. A human can then check the whole chain cold:

```powershell
npm run verify:lineage -- <prior-run-dir> <current-run-dir> [...more]
```

Each sealed capsule is signed with a local Ed25519 key whose public key travels inside the capsule, so a `capsule_ref` is a durable citation: paste it into notes, a job record, or a PR comment and it still resolves and verifies years later on a machine that never met this one. A signature proves who folded the capsule and that it has not changed — never that the observations were true. Manage the identity with `npm run key -- show|export|import`; there is no recovery if the key is lost, so export it if you want to keep it. `show` also prints how the key file is actually protected: `0600` on POSIX, and on Windows the ACL inherited from the data-root directory — which is user-restricted under `%USERPROFILE%` but no safer than wherever you point `LYHNA_CODEX_DATA`.

Claims carried forward are labeled against the record — `REFERENCES_RESOLVE`, `UNSUPPORTED`, or `UNRESOLVED_EVIDENCE` — and the claim text is retained, so the next window sees *which* claim was unverified, not just how many. `REFERENCES_RESOLVE` states the whole of what the system can establish: the cited reference points at an event this run witnessed. Whether it bears on the claim is the reader's judgment — no label here asserts a claim is true. (Packets folded by 0.1.31 and earlier carry the legacy `SUPPORTED` label, which meant only that references resolved; read it the same way.) Pass `privacy_mode: "proof"` at `begin_run` when a packet is meant to leave your machine: it projects claim text out while keeping every support label and evidence reference. See [SPEC.md](./SPEC.md#continuation-and-lineage-across-context-windows).

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
