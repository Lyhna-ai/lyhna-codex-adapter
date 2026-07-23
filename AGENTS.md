# AGENTS.md

- Read `SPEC.md` before changing behavior.
- Keep all product code in this repository. Do not modify `lyhna-witness`, `lyhna-mcp-proxy`, or `lyhna-core` in a sibling pass.
- Lyhna records coverage-scoped evidence; it never approves, blocks, certifies, merges, or declares correctness.
- Preserve explicit invocation, parent/child capability separation, deterministic receipt rendering, and exact-head staleness semantics.
- Do not store raw secrets, environment values, full prompts, full commands, tool output, PR bodies, or comment bodies.
- No agent reviews its own work. Review the complete diff against `SPEC.md` from a fresh agent before marking a PR ready.
