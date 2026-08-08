# Hetzner v0.1.34 portable acceptance evidence

This directory makes the fresh Hetzner proof-mode run independently checkable from a source checkout. It contains the exact copied run packet and a read-only verifier pinned to the captured file hashes, Lyhna public identity, and the v0.1.34 source implementation at `6faa65a2540b30cecf0af243df58ce889b958a18`.

Run from the repository root:

```bash
node docs/acceptance/hetzner-v0.1.34-2026-08-08/verify.mjs
```

With Node available, this checkout is the only evidence input. Success exits `0` and prints `PASS` for the integrity, refold, signature, and privacy gates plus the expected terminal values; any mismatch exits nonzero with the failed assertion.

The verifier checks:

- the checkout's exact `plugins/lyhna/src` file set and line-ending-normalized SHA-256 hashes match the pinned v0.1.34 source tree;
- the packet contains exactly the 11 expected files and no extras;
- every captured file's SHA-256;
- all 22 event hashes and predecessor links;
- the terminal seal anchor, canonical state hash, and deterministically re-rendered receipt bytes;
- the continuation capsule's deterministic v2 refold, content address, archived copy, and re-rendered `HANDOFF.md`;
- the Ed25519 signature against the embedded and explicitly pinned public identity;
- proof privacy mode plus a closed sensitive-key and private-data-shape audit across every file;
- the exact withheld-objective marker and a closed allowlist of generated proof statements across current and archived JSON artifacts;
- closeout attempt sequences `[1,2,3,4]`, ordinals `[1,1,2,3]`, exactly one terminal seal, and `CLOSED_UNSUPPORTED`.

## Honest boundary

This packet makes the run artifact portable. It verifies that the copied bytes form the internally consistent, signed packet produced by Lyhna v0.1.34.

It does **not** independently establish the Hetzner machine's current service state, file ownership, permissions, installed plugin tree, deployment correctness, adversary-resistant custody, or any real-world outcome. Those were separate live-host observations during migration acceptance. The run itself intentionally closes `CLOSED_UNSUPPORTED`: it exercises fail-closed closeout behavior when the declared deployment evidence producers are absent from the witnessed run.

The signature proves continuity with public identity `b66636f9ea8a58effc254f6a68df35762e8ce7b561b98f57debc35380bccaf6b`; it does not prove that the machine producing the packet was honest.

## Provenance

- Captured from the durable Hetzner data root on 2026-08-08.
- Run: `run_24cd4b2e-8328-46c6-ac37-7f1bab7c471b`.
- Renderer: `0.1.34`.
- Privacy mode: `proof`.
- Source code base for this verifier: adapter `v0.1.34`, commit `6faa65a2540b30cecf0af243df58ce889b958a18`.
