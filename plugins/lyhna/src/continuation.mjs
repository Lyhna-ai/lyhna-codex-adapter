// Continuation Capsule — what the NEXT window inherits, folded from this run's ledger.
//
// The problem this exists for: a human running real work across several context windows must
// hand state forward. Today that handoff is a document the agent writes about itself, after the
// fact, from the same context that is about to be discarded. It is narration, not record — so it
// drifts, and by the third or fourth window the thread is no longer describing the same project.
//
// The differentiator (and the honesty line): this capsule is ASSEMBLED from the hash-chained
// ledger the supervisor hook handlers wrote DURING the run. The agent's MCP surface can append
// claims; it cannot author this fold, cannot set a support label, and cannot seal. The agent does
// not write its own report card.
//
// Determinism is load-bearing, exactly as it is for the receipt: no clock, no randomness, no model
// calls. Identical (state, events) produce a byte-identical capsule, so `capsule_ref` is a stable
// identity the next run can commit to and a third party can recompute.
//
// HONESTY CEILING (unchanged): settled / open / next are DERIVED FROM STRUCTURE, never narrated.
// Every entry carries the evidence reference it was derived from. Absence inside configured
// coverage means `not observed`; it never proves an action did not happen elsewhere. Nothing here
// approves, blocks, certifies, or judges correctness.

import { canonicalJson, sha256 } from './util.mjs';

export const CONTINUATION_VERSION = 'lyhna.codex.continuation.v0';

function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key];
    if (typeof value !== 'string') continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.keys(counts).sort(codepointCompare).map((name) => [name, counts[name]]));
}

/**
 * Claimed-vs-actual, at the handoff layer.
 *
 * A builder claim is agent-reported by construction. Support is decided here, structurally, by
 * asking whether the claim's cited evidence resolves to an event hash in THIS run's ledger:
 *
 *   SUPPORTED           every cited reference resolves to a witnessed event in this run
 *   UNSUPPORTED         the claim cites no evidence at all
 *   UNRESOLVED_EVIDENCE at least one cited reference does not resolve within configured coverage
 *
 * UNRESOLVED_EVIDENCE is deliberately distinct from UNSUPPORTED: a reference this run cannot
 * resolve may still be valid elsewhere (another run, another surface). Calling that "unsupported"
 * would be the overclaim this system exists to prevent.
 */
export function labelClaims(events, privacyMode = 'verified_context') {
  const witnessedRefs = new Set(events.map((event) => `sha256:${event.event_hash}`));
  return events
    .filter((event) => event.type === 'builder_claim')
    .map((event) => {
      const refs = event.payload?.evidence_refs || [];
      const unresolved = refs.filter((ref) => !witnessedRefs.has(ref)).sort(codepointCompare);
      const support = refs.length === 0
        ? 'UNSUPPORTED'
        : unresolved.length > 0 ? 'UNRESOLVED_EVIDENCE' : 'SUPPORTED';
      // Verified Context is the default because the owner reading their own machine should see
      // their own claim. Proof Mode projects the text away for a packet that leaves the machine —
      // the support label and its evidence refs survive either way, so a content-blind packet is
      // still auditable, just not readable.
      const claim = {
        seq: event.seq,
        ref: `sha256:${event.event_hash}`,
        statement: event.payload?.statement ?? '',
        statement_ref: event.payload?.statement_ref ?? null,
        evidence_refs: [...refs].sort(codepointCompare),
        unresolved_refs: unresolved,
        support
      };
      if (privacyMode !== 'proof' && event.payload?.statement_text) {
        claim.statement_text = event.payload.statement_text;
      }
      return claim;
    })
    .sort((a, b) => a.seq - b.seq);
}

/** What a human should read for this claim: the words when retained, the shape when projected away. */
export function claimText(claim) {
  return claim.statement_text || claim.statement;
}

/** Structural facts this run actually observed. Counts and refs only — never interpretation. */
function buildWitnessed(state, events) {
  const attempted = events.filter((event) => event.type === 'hook_pretooluse').length;
  const returned = events.filter((event) => event.type === 'hook_posttooluse').length;
  return {
    event_count: state.ledger_count ?? events.length,
    ledger_tip: state.ledger_tip ?? null,
    origin_counts: countBy(events, 'origin'),
    type_counts: countBy(events, 'type'),
    tool_attempts_observed: attempted,
    tool_returns_observed: returned,
    children_started: Object.keys(state.children || {}).length,
    child_receipts_sealed: Object.keys(state.child_receipts || {}).length,
    child_receipts_retrieved: Object.values(state.child_receipts || {}).filter((item) => item.retrieved).length,
    pr_snapshots_observed: Object.keys(state.pr_snapshots || {}).length,
    evaluations_observed: Object.keys(state.evaluations || {}).length
  };
}

function entry(statement, ref) {
  return { statement, ref };
}

/**
 * SETTLED — terminal, witnessed facts the next window may rely on without redoing the work.
 * Every line is derived from a structural fact already in the ledger or sealed state.
 */
function buildSettled(state, events, claims) {
  const settled = [];
  const sealEvent = events.find((event) => event.type === 'run_sealed');
  if (state.sealed && sealEvent) {
    settled.push(entry(`This run sealed at event ${sealEvent.seq}; its ledger is terminal.`, `sha256:${sealEvent.event_hash}`));
  }
  for (const snapshot of Object.values(state.pr_snapshots || {}).sort((a, b) => codepointCompare(a.id, b.id))) {
    if (snapshot.status !== 'CONSISTENT') continue;
    settled.push(entry(
      `PR ${snapshot.repository}#${snapshot.pr_number} was observed at exact head ${snapshot.head_after}.`,
      snapshot.id
    ));
  }
  for (const evaluation of Object.values(state.evaluations || {}).sort((a, b) => codepointCompare(a.id, b.id))) {
    if (evaluation.status !== 'RECORDED' || !evaluation.child_receipt_retrieved) continue;
    settled.push(entry(
      `An independent evaluator recorded findings at head ${evaluation.expected_head} and its sealed receipt was retrieved by the parent.`,
      evaluation.id
    ));
  }
  for (const claim of claims) {
    if (claim.support !== 'SUPPORTED') continue;
    settled.push(entry(`Builder claim supported by witnessed evidence: ${claimText(claim)}`, claim.ref));
  }
  return settled;
}

/**
 * OPEN — structural conditions that were still unresolved when this capsule was folded.
 * These are observations, never intent judgments: an open item means "not observed closed."
 */
function buildOpen(state, events, claims) {
  const open = [];
  if (!state.sealed) {
    const closeRequested = events.find((event) => event.type === 'close_requested');
    const deferred = events.filter((event) => event.type === 'close_deferred').at(-1);
    if (closeRequested) {
      for (const code of [...(deferred?.payload?.blockers || [])].sort(codepointCompare)) {
        open.push(entry(`Close was requested but deferred on blocker ${code}.`, `sha256:${closeRequested.event_hash}`));
      }
      if (!deferred?.payload?.blockers?.length) {
        open.push(entry('Close was requested; this run had not sealed as of this fold.', `sha256:${closeRequested.event_hash}`));
      }
    } else {
      open.push(entry(`No close request was observed; this run is OPEN at event ${state.ledger_count ?? events.length}.`, null));
    }
  }
  for (const child of Object.values(state.children || {}).sort((a, b) => codepointCompare(a.id, b.id))) {
    if (state.child_receipts?.[child.receipt_id]) continue;
    open.push(entry(`A delegated child started and no sealed lifecycle receipt was observed for it.`, child.id));
  }
  for (const evaluation of Object.values(state.evaluations || {}).sort((a, b) => codepointCompare(a.id, b.id))) {
    if (evaluation.status === 'RECORDED' && evaluation.child_receipt_retrieved) continue;
    open.push(entry(
      `Evaluation ${evaluation.id} is not a retrieved terminal finding (status ${evaluation.status}, retrieved ${Boolean(evaluation.child_receipt_retrieved)}).`,
      evaluation.id
    ));
  }
  for (const snapshot of Object.values(state.pr_snapshots || {}).sort((a, b) => codepointCompare(a.id, b.id))) {
    if (snapshot.status === 'CONSISTENT') continue;
    open.push(entry(`PR snapshot ${snapshot.id} is ${snapshot.status}; its head was not observed consistent.`, snapshot.id));
  }
  for (const claim of claims) {
    if (claim.support === 'SUPPORTED') continue;
    open.push(entry(`Builder claim is ${claim.support} within configured coverage: ${claimText(claim)}`, claim.ref));
  }
  return open;
}

/**
 * NEXT — the mechanical action that would close each open item. Derived one-to-one from OPEN,
 * so this list can never introduce work the ledger did not already show as unresolved.
 */
function buildNext(open) {
  return open.map((item) => {
    if (item.statement.startsWith('Builder claim is UNSUPPORTED')) {
      return entry('Re-verify this claim against the record before relying on it; nothing in this run supports it.', item.ref);
    }
    if (item.statement.startsWith('Builder claim is UNRESOLVED_EVIDENCE')) {
      return entry('Resolve this claim\'s cited evidence, or treat the claim as unverified in this window.', item.ref);
    }
    if (item.statement.startsWith('Evaluation ')) {
      return entry('Complete or re-run this evaluation and retrieve its sealed receipt before relying on its findings.', item.ref);
    }
    if (item.statement.startsWith('PR snapshot ')) {
      return entry('Re-snapshot this PR at its current head; the earlier observation is not current.', item.ref);
    }
    if (item.statement.startsWith('A delegated child started')) {
      return entry('Account for this child before closing; no sealed lifecycle receipt was observed.', item.ref);
    }
    return entry('Resolve this closeout condition before treating the run as complete.', item.ref);
  });
}

/**
 * The carry-forward core: exactly what the next window inherits, and nothing that varies with how
 * this capsule happened to be rendered. `inherits_state_hash` in a successor run commits to THIS
 * value, which is why it must exclude presentation-only fields.
 */
export function buildCarryForward(capsule) {
  return {
    run_id: capsule.run_id,
    mode: capsule.mode,
    privacy_mode: capsule.privacy_mode,
    status: capsule.status,
    objective: capsule.objective,
    objective_origin: capsule.objective_origin,
    ledger_tip: capsule.witnessed.ledger_tip,
    event_count: capsule.witnessed.event_count,
    settled: capsule.settled,
    open: capsule.open,
    next: capsule.next
  };
}

export function deriveStateHash(capsule) {
  return sha256(canonicalJson(buildCarryForward(capsule)));
}

/**
 * `capsule_ref` is the identity a successor run commits to.
 *
 * Derived over the capsule minus its own ref AND minus the signature block: the ref names the WORK,
 * not who attested it. That separation is what lets the same fold be signed by more than one party
 * (a second reviewer counter-signing later) without changing what the capsule is called.
 */
export function deriveCapsuleRef(capsule) {
  const { capsule_ref: _ignored, signature: _attestation, ...rest } = capsule;
  return sha256(canonicalJson(rest));
}

export function buildContinuation(state, events) {
  const privacyMode = state.privacy_mode || 'verified_context';
  const claims = labelClaims(events, privacyMode);
  const open = buildOpen(state, events, claims);
  const capsule = {
    schema: CONTINUATION_VERSION,
    run_id: state.id,
    mode: state.mode,
    privacy_mode: privacyMode,
    status: state.sealed ? 'SEALED' : state.close_requested ? 'CLOSE_REQUESTED_NOT_SEALED' : 'OPEN',
    objective: state.objective,
    objective_origin: state.objective_origin,
    // The lineage edge: which prior capsule this run declared it continues from. Sealed into the
    // run_begun event, therefore inside the hash chain, therefore covered by the seal anchor.
    inherits: state.inherits || null,
    witnessed: buildWitnessed(state, events),
    claims,
    settled: buildSettled(state, events, claims),
    open,
    next: buildNext(open),
    limitations: [
      'This capsule was folded from the run ledger by the supervisor hook path; the agent did not author it.',
      'Settled, open, and next are derived from structural observations, not from agent narration.',
      'Absence inside configured coverage means not observed; it does not prove an action did not occur.',
      'Nothing here approves, blocks, certifies, or judges correctness.'
    ]
  };
  capsule.state_hash = deriveStateHash(capsule);
  capsule.capsule_ref = deriveCapsuleRef(capsule);
  return capsule;
}

export function renderContinuationJson(state, events) {
  return canonicalJson(buildContinuation(state, events), true);
}
