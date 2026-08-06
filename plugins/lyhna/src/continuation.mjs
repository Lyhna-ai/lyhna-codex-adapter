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
 * Fold versions. The continuation capsule is not hash-anchored — the lineage checker re-FOLDS it
 * from the ledger instead of comparing a stored hash, which catches a file regenerated wholesale.
 * The cost is that changing the fold silently invalidates every packet an earlier build wrote, so
 * each fold generation is kept and selected explicitly.
 *
 *   v0_1_28      the 0.1.28 fold: no privacy_mode or objective_text in capsule/carry-forward.
 *   v0_1_29_30   the 0.1.29-0.1.30 fold: privacy_mode present, objective_text absent.
 *   v0            the 0.1.31 fold: privacy_mode and objective_text present.
 *
 * All three historical generations share the KNOWN WRONG claim rule: any event could support any
 * claim, so a claim citing another claim — or citing an unrelated `run_begun` — rendered SUPPORTED
 * and was promoted into `settled`. Preserved verbatim and never used for new packets, each old
 * packet still re-folds to its own published bytes and stays historically verifiable.
 *   v1  0.1.32. A cited reference is only ever reported as RESOLVING, never as supporting,
 *       and builder claims are never promoted into `settled`.
 *   v2  0.1.33 onward. Adds the frozen claim contract and compiler/control carry-forward while
 *       preserving every v1 field and its claim semantics.
 *
 * Dispatch reads the adapter version from the hash-chained `run_sealed` / `checkpoint_anchor`
 * event, never from the capsule: the capsule is unanchored, so a `continuation_fold_version` field
 * read from it would let a forged packet choose the reducer that makes it verify.
 */
export const CURRENT_FOLD_VERSION = 'v2';
export const KNOWN_FOLD_VERSIONS = ['v0_1_28', 'v0_1_29_30', 'v0', 'v1', 'v2'];

const PRE_DECLARATION_FOLDS = new Set(['v0_1_28', 'v0_1_29_30', 'v0']);
const LEGACY_CLAIM_FOLDS = PRE_DECLARATION_FOLDS;

function includesPrivacyMode(foldVersion) {
  return foldVersion !== 'v0_1_28';
}

function includesObjectiveText(foldVersion) {
  return foldVersion === 'v0' || foldVersion === 'v1' || foldVersion === 'v2';
}

function buildClaimCompilerProjection(events) {
  const contractEvent = events.find((event) => event.type === 'claim_contract_declared');
  if (!contractEvent) return null;
  const compiledEvent = [...events].reverse().find((event) => event.type === 'claim_compiled');
  const producerRequests = events.filter((event) => event.type === 'producer_requested');
  const producerTerminals = new Set(events.filter((event) => event.type === 'producer_terminal').map((event) => event.payload?.producer_id));
  const diagnostics = new Map();
  for (const event of events) {
    if (event.type === 'diagnostic_emitted') diagnostics.set(event.payload?.diagnostic_id, { ...event.payload, event_ref: `sha256:${event.event_hash}` });
    if (event.type === 'diagnostic_resolved' && diagnostics.has(event.payload?.diagnostic_id)) {
      diagnostics.set(event.payload.diagnostic_id, { ...diagnostics.get(event.payload.diagnostic_id), status: 'RESOLVED', resolved_ref: `sha256:${event.event_hash}` });
    }
  }
  const latestAttempt = [...events].reverse().find((event) => event.type === 'closeout_attempted');
  return {
    claim_contract_ref: `sha256:${contractEvent.event_hash}`,
    contract: contractEvent.payload?.contract ?? null,
    profile_structural: contractEvent.payload?.profile_structural ?? null,
    profile_requirements_hash: contractEvent.payload?.profile_requirements_hash ?? null,
    compiled_state: compiledEvent?.payload ?? null,
    pending_producers: producerRequests
      .map((event) => event.payload?.producer_id)
      .filter((id) => id && !producerTerminals.has(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort(codepointCompare),
    diagnostics: [...diagnostics.values()].sort((a, b) => codepointCompare(a.diagnostic_id, b.diagnostic_id)),
    attempt_frontier: latestAttempt?.payload ?? null,
    gate_samples: events.filter((event) => event.type === 'gate_sample_observed').map((event) => event.payload)
  };
}

/**
 * Which fold generation a HISTORICAL renderer used — packets from builds that predate the
 * chained `continuation_fold_version` field. A closed whitelist, deliberately: inferring a fold
 * from an open-ended version range means a renderer from the future silently gets folded with
 * current rules, which is exactly the "never guess an unknown fold" requirement inverted. A
 * renderer not in this list, with no chained fold declaration, is unknown and must be reported.
 * Each listed renderer maps to the reducer that reproduces its actual continuation and
 * carry-forward shape byte-for-byte. Versions 0.1.28 and 0.1.29 require their own historical
 * reducers; mapping either to v0 would falsely report an untampered packet as changed.
 */
const HISTORICAL_RENDERER_FOLDS = {
  '0.1.28': ['v0_1_28'],
  '0.1.29': ['v0_1_29_30'],
  // "0.1.30" is one renderer STRING spanning two shipped shapes: objective_text entered the
  // carry-forward mid-version, before the release was cut. The published 0.1.30 bundle — the only
  // 0.1.30 artifact with real packets in the wild — folds the v0 shape; the short-lived pre-release
  // commits folded v0_1_29_30. The string cannot distinguish them, so both are candidates and the
  // packet's own bytes decide: the checker accepts whichever reducer reproduces the published
  // capsule byte-for-byte. This is content-addressed dispatch over a closed set of legitimate
  // shipped shapes — NOT "the reducer that makes it verify": the candidates share identical claim
  // semantics, the set is fixed here rather than by anything in the packet, and a forged packet
  // gains nothing because matching still requires bytes that actually refold from the ledger.
  '0.1.30': ['v0', 'v0_1_29_30'],
  '0.1.31': ['v0']
};

/** All fold generations a historical renderer string could have shipped, most likely first. */
export function foldCandidatesForRenderer(renderer) {
  return HISTORICAL_RENDERER_FOLDS[String(renderer ?? '')] ?? null;
}

/**
 * Claimed-vs-actual, at the handoff layer.
 *
 * A builder claim is agent-reported by construction. What this system can establish about it is
 * narrow and worth stating exactly:
 *
 *   REFERENCES_RESOLVE  every cited reference resolves to an event this run witnessed
 *   UNSUPPORTED         nothing is cited, or everything cited is the agent's own narration
 *   UNRESOLVED_EVIDENCE at least one cited reference does not resolve within configured coverage
 *
 * REFERENCES_RESOLVE deliberately does NOT say the claim is supported. Hash resolution is not
 * semantic support: "I deployed production" citing `run_begun` resolves perfectly and proves only
 * that the run began. No allowlist fixes this either — an unrelated but legitimate tool return
 * still proves the wrong action. The honest ceiling is that the reference points at something real,
 * and the reader decides whether it bears on the statement.
 *
 * UNRESOLVED_EVIDENCE stays distinct from UNSUPPORTED: a reference this run cannot resolve may be
 * valid elsewhere, and calling that unsupported would be its own overclaim.
 */
function labelClaimsV1(events, privacyMode) {
  // An agent's own assertion is never evidence for another of its assertions. The ledger witnesses
  // that a claim was MADE; it never witnesses that it was TRUE.
  const authored = new Set(
    events.filter((event) => event.origin === 'agent_reported').map((event) => `sha256:${event.event_hash}`)
  );
  const witnessedRefs = new Set(
    events.filter((event) => event.origin !== 'agent_reported').map((event) => `sha256:${event.event_hash}`)
  );
  return events
    .filter((event) => event.type === 'builder_claim')
    .map((event) => {
      const refs = event.payload?.evidence_refs || [];
      // Resolves to nothing at all. Kept distinct from narration: a ref this run cannot see may be
      // valid elsewhere, while a ref to narration resolves perfectly well and still is not evidence.
      const unresolved = refs.filter((ref) => !witnessedRefs.has(ref) && !authored.has(ref)).sort(codepointCompare);
      const resolving = refs.filter((ref) => witnessedRefs.has(ref));
      // Citing only narration is evidentially identical to citing nothing, so it lands on
      // UNSUPPORTED rather than UNRESOLVED_EVIDENCE — the ref did resolve, and saying otherwise
      // would be its own small overclaim.
      const support = unresolved.length > 0
        ? 'UNRESOLVED_EVIDENCE'
        : resolving.length === 0 ? 'UNSUPPORTED' : 'REFERENCES_RESOLVE';
      return finishClaim(event, refs, unresolved, support, privacyMode);
    })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The 0.1.31 fold, preserved so packets written by that build still verify against themselves.
 * Do not "fix" it — its wrongness is the historical fact a v0 packet is entitled to reproduce.
 */
function labelClaimsV0(events, privacyMode) {
  const witnessedRefs = new Set(events.map((event) => `sha256:${event.event_hash}`));
  return events
    .filter((event) => event.type === 'builder_claim')
    .map((event) => {
      const refs = event.payload?.evidence_refs || [];
      const unresolved = refs.filter((ref) => !witnessedRefs.has(ref)).sort(codepointCompare);
      const support = refs.length === 0
        ? 'UNSUPPORTED'
        : unresolved.length > 0 ? 'UNRESOLVED_EVIDENCE' : 'SUPPORTED';
      return finishClaim(event, refs, unresolved, support, privacyMode);
    })
    .sort((a, b) => a.seq - b.seq);
}

/** Shared claim shape. Identical across folds — only the support decision differs. */
function finishClaim(event, refs, unresolved, support, privacyMode) {
  // Verified Context is the default because the owner reading their own machine should see their
  // own claim. Proof Mode projects the text away for a packet that leaves the machine — the support
  // label and its evidence refs survive either way, so a content-blind packet is still auditable.
  const claim = {
    seq: event.seq,
    ref: `sha256:${event.event_hash}`,
    ...(event.payload?.builder_claim_id ? { builder_claim_id: event.payload.builder_claim_id } : {}),
    ...(event.payload?.builder_claim_ordinal ? { builder_claim_ordinal: event.payload.builder_claim_ordinal } : {}),
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
}

export function labelClaims(events, privacyMode = 'verified_context', foldVersion = CURRENT_FOLD_VERSION) {
  return LEGACY_CLAIM_FOLDS.has(foldVersion) ? labelClaimsV0(events, privacyMode) : labelClaimsV1(events, privacyMode);
}

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
function buildSettled(state, events, claims, foldVersion) {
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
  // v1 promotes NO builder claim into settled. Settled means terminal, witnessed facts a successor
  // may rely on without redoing the work, and no structural check can establish that an agent's
  // statement is true — only that a reference it cited points at something real. The claims list
  // carries every claim with its label; that is where a reader judges them. Under a historical fold
  // the promotion is reproduced exactly as it happened, because an old packet is entitled to
  // re-fold to its own bytes.
  if (LEGACY_CLAIM_FOLDS.has(foldVersion)) {
    for (const claim of claims) {
      if (claim.support !== 'SUPPORTED') continue;
      settled.push(entry(`Builder claim supported by witnessed evidence: ${claimText(claim)}`, claim.ref));
    }
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
    if (claim.support === 'REFERENCES_RESOLVE') {
      // Not settled, and not silent either. The references point at real witnessed events; whether
      // they bear on the statement was never evaluated, and the successor must be told so rather
      // than left to read absence-from-open as cleared.
      open.push(entry(`Builder claim cites references that resolve, but their relevance to the claim was never evaluated: ${claimText(claim)}`, claim.ref));
      continue;
    }
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
    if (item.statement.startsWith('Builder claim cites references that resolve')) {
      // Not a sealing blocker, and not cleared either: the references point at real events, and
      // whether they bear on the statement is exactly what was never evaluated.
      return entry('Re-check whether the cited events actually support this claim before relying on it; resolution was verified, relevance was not.', item.ref);
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
export function buildCarryForward(capsule, foldVersion = CURRENT_FOLD_VERSION) {
  return {
    run_id: capsule.run_id,
    mode: capsule.mode,
    ...(includesPrivacyMode(foldVersion) ? { privacy_mode: capsule.privacy_mode } : {}),
    status: capsule.status,
    objective: capsule.objective,
    ...(includesObjectiveText(foldVersion) ? { objective_text: capsule.objective_text ?? null } : {}),
    objective_origin: capsule.objective_origin,
    ledger_tip: capsule.witnessed.ledger_tip,
    event_count: capsule.witnessed.event_count,
    settled: capsule.settled,
    open: capsule.open,
    next: capsule.next,
    ...(foldVersion === 'v2' ? { claim_compiler: capsule.claim_compiler ?? null } : {})
  };
}

export function deriveStateHash(capsule, foldVersion = CURRENT_FOLD_VERSION) {
  return sha256(canonicalJson(buildCarryForward(capsule, foldVersion)));
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

export function buildContinuation(state, events, foldVersion = CURRENT_FOLD_VERSION) {
  const privacyMode = state.privacy_mode || 'verified_context';
  const claims = labelClaims(events, privacyMode, foldVersion);
  const open = buildOpen(state, events, claims);
  const capsule = {
    schema: CONTINUATION_VERSION,
    // Declared for a reader's benefit only. Verification NEVER dispatches on this field — the
    // capsule is unanchored, so trusting it would let a forged packet pick the reducer that makes
    // it verify. The checker reads the renderer from the hash-chained anchor and cross-checks.
    ...(PRE_DECLARATION_FOLDS.has(foldVersion) ? {} : { continuation_fold_version: foldVersion }),
    run_id: state.id,
    mode: state.mode,
    ...(includesPrivacyMode(foldVersion) ? { privacy_mode: privacyMode } : {}),
    status: state.sealed ? (state.terminal_status || events.find((event) => event.type === 'run_sealed')?.payload?.status || 'SEALED') : state.close_requested ? 'CLOSE_REQUESTED_NOT_SEALED' : 'OPEN',
    objective: state.objective,
    ...(includesObjectiveText(foldVersion) && privacyMode !== 'proof' && state.objective_text
      ? { objective_text: state.objective_text }
      : {}),
    objective_origin: state.objective_origin,
    // The lineage edge: which prior capsule this run declared it continues from. Sealed into the
    // run_begun event, therefore inside the hash chain, therefore covered by the seal anchor.
    inherits: state.inherits || null,
    witnessed: buildWitnessed(state, events),
    claims,
    ...(foldVersion === 'v2' ? { claim_compiler: buildClaimCompilerProjection(events) } : {}),
    settled: buildSettled(state, events, claims, foldVersion),
    open,
    next: buildNext(open),
    limitations: [
      'This capsule was folded from the run ledger by the supervisor hook path; the agent did not author it.',
      'Settled, open, and next are derived from structural observations, not from agent narration.',
      'Absence inside configured coverage means not observed; it does not prove an action did not occur.',
      ...(foldVersion === 'v2'
        ? ['Nothing here approves, certifies, or judges correctness; a declared Lyhna claim gate may refuse only an unsupported Lyhna seal.']
        : ['Nothing here approves, blocks, certifies, or judges correctness.'])
    ]
  };
  capsule.state_hash = deriveStateHash(capsule, foldVersion);
  capsule.capsule_ref = deriveCapsuleRef(capsule);
  return capsule;
}

export function renderContinuationJson(state, events) {
  return canonicalJson(buildContinuation(state, events), true);
}
