# AGENTS.md

- Read `SPEC.md` before changing behavior. For claim-compiler work in v0.1.33 through v0.1.36,
  also read the normative ratified addendum at
  `docs/proposals/CLAIM-COMPILER-SPEC-2026-08-05.md`.
- Keep all product code in this repository. Do not modify `lyhna-witness`, `lyhna-mcp-proxy`, or `lyhna-core` in a sibling pass.
- Lyhna records coverage-scoped evidence; it never approves, certifies, merges, deploys, or declares
  correctness. At an explicitly declared claim gate it may refuse an unsupported Lyhna claim or
  successful seal, while leaving the underlying external action untouched.
- Preserve explicit invocation, parent/child capability separation, deterministic receipt rendering, and exact-head staleness semantics.
- Do not store raw secrets, environment values, full prompts, full commands, tool output, PR bodies, or comment bodies.
- No agent reviews its own work. Review the complete diff against `SPEC.md` from a fresh agent before marking a PR ready.
