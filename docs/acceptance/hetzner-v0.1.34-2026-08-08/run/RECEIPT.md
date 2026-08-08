# Lyhna Codex Run Receipt

- Run: `run_24cd4b2e-8328-46c6-ac37-7f1bab7c471b`
- Status: **CLOSED_UNSUPPORTED**
- Mode: `full`
- Build record: **witnessed_within_configured_coverage**
- Objective origin: `agent_reported`

## Lifecycle

- Lifecycle status: **SEALED**

This run is SEALED; the seal block records the closeout anchor.

## Seal

- Seal status: **SEALED**
- Seal-anchor hash: `sha256:bf4cb7f68d67a12608df5f744d23f41e37c08eef31080253b711628545f84de4`
- Ledger tip hash: `sha256:6dd9a1902b790edc96249619b79c3dde467ddd61a2ff328a3d95391daea62888`
- Event count: 22

Evidence is ordered strictly by ledger sequence (seq); closeout order can be reconstructed from these numbers alone.

Per-child retrieval status as of closeout: none recorded.

_Local verification proves hash-chain consistency of this ledger and its sealed anchor. It does not prove adversary-resistant custody of the local data directory against an actor with unrestricted filesystem access._

## Prior open runs in this session

- None observed when this run began.

## Coverage

Absence means not observed within configured coverage; it does not prove an action did not occur elsewhere.

- Invocation: No hook-observed invocation preceded this run; the objective is agent-reported.
- Delegated children: No ordinary delegated-child lifecycle was observed during this run.
- Witnessing boundary: Witnessing began at this run's first event; earlier session activity was not observed.

## Evidence (ledger order)

- 1. `mcp_routed` — run begun
- 2. `mcp_routed` — claim contract declared
- 3. `runtime_hook` — claim compiled
- 4. `mcp_routed` — close requested
- 5. `runtime_hook` — turn checkpoint
- 6. `runtime_hook` — closeout attempted
- 7. `runtime_hook` — diagnostic emitted
- 8. `runtime_hook` — checkpoint anchor
- 9. `mcp_routed` — producer requested
- 10. `runtime_hook` — claim compiled
- 11. `runtime_hook` — turn checkpoint
- 12. `runtime_hook` — closeout attempted
- 13. `runtime_hook` — diagnostic resolved
- 14. `runtime_hook` — diagnostic emitted
- 15. `runtime_hook` — checkpoint anchor
- 16. `runtime_hook` — turn checkpoint
- 17. `runtime_hook` — closeout attempted
- 18. `runtime_hook` — checkpoint anchor
- 19. `runtime_hook` — turn checkpoint
- 20. `runtime_hook` — closeout attempted
- 21. `runtime_hook` — closeout envelope generated
- 22. `runtime_hook` — run sealed

## Pull request head chains

- None recorded.

## Independent evaluations

- None recorded.

## Child receipts

- None recorded.

## Limitations

- This receipt records supported observations and attributed reports; it is not an approval or correctness judgment.
