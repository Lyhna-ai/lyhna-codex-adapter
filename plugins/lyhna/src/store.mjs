import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText, assert, canonicalJson, dataRoot, ORIGINS, readJson, sha256, withLock } from './util.mjs';
import { boundedText, objectiveText, promptSynopsis, reference, sanitizeClaim, structuralSummary } from './redact.mjs';
import { renderReceiptJson, renderReceiptMarkdown } from './receipt.mjs';
import {
  buildContinuation,
  deriveCapsuleRef,
  renderContinuationJson,
  CURRENT_FOLD_VERSION,
  KNOWN_FOLD_VERSIONS,
  foldCandidatesForRenderer
} from './continuation.mjs';
import { renderHandoffMarkdown } from './handoff.mjs';
import { loadOrCreateKeypair, signCapsule } from './signing.mjs';
import { ADAPTER_VERSION } from './version.mjs';
import {
  compileClaim,
  getClaimProfile,
  isCanonicalObservedAt,
  validateClaimContract
} from './claim-compiler.mjs';

const ZERO_HASH = '0'.repeat(64);
const CONFIGURED_HOOKS = ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];
const COMPILED_CLAIM_FIELDS = [
  'contract_id', 'profile_ref', 'requested_state', 'highest_supported_state',
  'maximal_supported_nodes', 'state_results', 'missing', 'pending_producers',
  'contradictions', 'currentness', 'next_verifier', 'eligible_evidence_frontier',
  'material_control_frontier', 'input_digest', 'claim_contract_ref', 'fold_version'
];
const HOOK_PROOF_FIELDS = ['event', 'event_id', 'model', 'tool_name', 'cwd_ref', 'payload_ref', 'support', 'outcome'];
// Every fold-v2 event family has one closed top-level schema in both privacy modes. Structural
// validation is mode-independent; proof mode then applies the narrower at-write text projection.
// Keeping those jobs separate prevents verified-context payloads from bypassing the closed schema
// and prevents untrusted identity-shaped values from being preserved merely because they look
// structural.
const EVENT_PAYLOAD_FIELDS = new Map([
  ['builder_claim', ['builder_claim_id', 'builder_claim_ordinal', 'evidence_refs', 'statement', 'statement_ref', 'statement_text', 'text_withheld']],
  ['checkpoint_anchor', ['covers_seq', 'tip_hash', 'state_hash', 'receipt_json_hash', 'receipt_markdown_hash', 'receipt_renderer', 'continuation_fold_version', 'delivery_slot_ref']],
  ['child_receipt_retrieved', ['receipt_id', 'content_ref']],
  ['child_receipt_sealed', ['receipt_id', 'role', 'status', 'content_ref']],
  ['child_started', ['child_id', 'role', 'status']],
  ['child_stop_observed', ['child_id', 'role', 'status']],
  ['claim_compiled', COMPILED_CLAIM_FIELDS],
  ['claim_contract_declared', ['contract', 'profile_structural', 'profile_requirements_hash', 'profile_display', 'contract_display', 'text_withheld']],
  ['claim_rejected', ['code', 'capability_kind']],
  ['close_deferred', ['blockers', 'receipt_renderer']],
  ['close_requested', ['request_id', 'reason', 'reason_ref', 'text_withheld']],
  ['closeout_attempted', ['claim_contract_ref', 'gate_id', 'blocker_fingerprint', 'ordinal', 'attempt_sequence', 'delivery_slot_ref', 'input_digest', 'eligible_evidence_frontier', 'material_control_frontier', 'blockers']],
  ['closeout_envelope_generated', ['envelope_id', 'outcome', 'profile_id', 'requested_state', 'supported_state', 'scope_ref', 'eligible_evidence_frontier', 'material_control_frontier', 'input_digest', 'claim_contract_ref', 'fold_version', 'blockers', 'next_verifier', 'narrative', 'text_withheld']],
  ['continuation_lease_transferred', ['capsule_ref', 'predecessor_parent_ref', 'successor_parent_ref', 'active_child_refs']],
  ['diagnostic_emitted', ['diagnostic_id', 'diagnostic_status', 'claim_contract_ref', 'fold_version', 'input_digest', 'eligible_evidence_frontier', 'material_control_frontier', 'blocker_fingerprint', 'supported_state', 'requested_state', 'missing', 'next_verifier', 'message', 'narrative', 'text_withheld']],
  ['diagnostic_resolved', ['diagnostic_id', 'diagnostic_status', 'claim_contract_ref', 'fold_version', 'input_digest', 'eligible_evidence_frontier', 'material_control_frontier', 'blocker_fingerprint', 'supported_state', 'requested_state', 'missing', 'next_verifier', 'message', 'narrative', 'text_withheld']],
  ['evaluation_claimed', ['evaluation_request_id', 'child_agent_hash']],
  ['evaluation_finding', ['finding_id', 'finding_ordinal', 'statement', 'statement_text', 'statement_ref', 'evidence_refs', 'evaluation_request_id', 'expected_head', 'checkout_head_before', 'checkout_head_after', 'checkout_clean_before', 'checkout_clean_after', 'checkout_detached_before', 'checkout_detached_after', 'checkout_integrity', 'text_withheld']],
  ['evaluation_requested', ['evaluation_request_id', 'snapshot_id', 'expected_head', 'trigger']],
  ['evidence_observed', ['contract_id', 'profile_requirements_hash', 'requirement_id', 'event_kind', 'producer_id', 'producer_identity', 'source_cursor', 'observed_at', 'subject_binding']],
  ['gate_evaluated', [...COMPILED_CLAIM_FIELDS, 'gate_id']],
  ['hook_permissionrequest', HOOK_PROOF_FIELDS],
  ['hook_posttooluse', HOOK_PROOF_FIELDS],
  ['hook_pretooluse', HOOK_PROOF_FIELDS],
  ['hook_subagentstart', HOOK_PROOF_FIELDS],
  ['hook_subagentstop', HOOK_PROOF_FIELDS],
  ['hook_userpromptsubmit', HOOK_PROOF_FIELDS],
  ['pr_refreshed', ['snapshot_id', 'observed_head', 'status']],
  ['pr_snapshot', ['id', 'repository', 'pr_number', 'head_before', 'head_after', 'status', 'counts', 'failures']],
  ['producer_requested', ['contract_id', 'claim_contract_ref', 'producer_id', 'expected_identity']],
  ['producer_terminal', ['contract_id', 'claim_contract_ref', 'producer_id', 'producer_identity', 'status', 'source_cursor', 'observed_at', 'evidence_refs']],
  ['run_begun', ['mode', 'privacy_mode', 'objective_origin', 'objective_ref', 'claim_contract_id', 'text_withheld', 'invocation', 'open_predecessors', 'inherits']],
  ['run_sealed', ['status', 'receipt_renderer', 'continuation_fold_version', 'claim_contract_ref', 'supported_state', 'requested_state', 'closeout_envelope_ref']],
  ['turn_checkpoint', ['status', 'receipt_renderer']]
]);
// Identity-like fields on event families that can receive model-authored prose must declare their
// provenance here. Proof projection rejects an undeclared identity field and rejects every field
// marked prose-derived before hashing. This turns the privacy rule into a closed registry instead
// of relying on reviewers to notice each new `*_ref` or `*_id` point fix.
export const PROOF_IDENTITY_PROVENANCE = Object.freeze({
  'builder_claim.builder_claim_id': 'supervisor_structural',
  'builder_claim.evidence_refs': 'witnessed_structural_refs',
  'builder_claim.statement_ref': 'prose_derived_forbidden',
  'evaluation_finding.finding_id': 'supervisor_structural',
  'evaluation_finding.evaluation_request_id': 'supervisor_structural',
  'evaluation_finding.evidence_refs': 'witnessed_structural_refs',
  'evaluation_finding.statement_ref': 'prose_derived_forbidden',
  'close_requested.request_id': 'supervisor_structural',
  'close_requested.reason_ref': 'prose_derived_forbidden',
  'claim_contract_declared.profile_requirements_hash': 'supervisor_structural',
  'diagnostic_emitted.diagnostic_id': 'supervisor_structural',
  'diagnostic_emitted.claim_contract_ref': 'supervisor_structural',
  'diagnostic_emitted.input_digest': 'compiler_structural',
  'diagnostic_emitted.eligible_evidence_frontier': 'compiler_structural',
  'diagnostic_emitted.material_control_frontier': 'compiler_structural',
  'diagnostic_emitted.blocker_fingerprint': 'compiler_structural',
  'diagnostic_resolved.diagnostic_id': 'supervisor_structural',
  'diagnostic_resolved.claim_contract_ref': 'supervisor_structural',
  'diagnostic_resolved.input_digest': 'compiler_structural',
  'diagnostic_resolved.eligible_evidence_frontier': 'compiler_structural',
  'diagnostic_resolved.material_control_frontier': 'compiler_structural',
  'diagnostic_resolved.blocker_fingerprint': 'compiler_structural',
  'closeout_attempted.claim_contract_ref': 'supervisor_structural',
  'closeout_attempted.gate_id': 'supervisor_structural',
  'closeout_attempted.delivery_slot_ref': 'host_ledger_structural',
  'closeout_attempted.input_digest': 'compiler_structural',
  'closeout_attempted.eligible_evidence_frontier': 'compiler_structural',
  'closeout_attempted.material_control_frontier': 'compiler_structural',
  'closeout_attempted.blocker_fingerprint': 'compiler_structural',
  'checkpoint_anchor.delivery_slot_ref': 'host_ledger_structural',
  'closeout_envelope_generated.envelope_id': 'supervisor_structural',
  'closeout_envelope_generated.profile_id': 'supervisor_structural',
  'closeout_envelope_generated.scope_ref': 'supervisor_structural',
  'closeout_envelope_generated.claim_contract_ref': 'supervisor_structural',
  'closeout_envelope_generated.input_digest': 'compiler_structural',
  'closeout_envelope_generated.eligible_evidence_frontier': 'compiler_structural',
  'closeout_envelope_generated.material_control_frontier': 'compiler_structural',
  'run_begun.objective_ref': 'supervisor_structural',
  'run_begun.claim_contract_id': 'supervisor_structural',
  'hook_*.event_id': 'host_structural',
  'hook_*.cwd_ref': 'host_context_digest',
  'hook_*.payload_ref': 'prose_derived_forbidden'
});
const PROOF_IDENTITY_FIELD = /(?:^|_)(?:id|ref|refs|digest|fingerprint|hash)$/;
const PROOF_IDENTITY_EVENT = new Set([
  'builder_claim', 'claim_contract_declared', 'close_requested', 'closeout_attempted',
  'closeout_envelope_generated', 'diagnostic_emitted', 'diagnostic_resolved',
  'evaluation_finding', 'run_begun'
]);
const PROOF_SUPERVISOR_OWNED_EVENTS = new Set([
  'builder_claim',
  'claim_contract_declared',
  'close_requested',
  'closeout_attempted',
  'closeout_envelope_generated',
  'diagnostic_emitted',
  'diagnostic_resolved',
  'evaluation_finding',
  'run_begun'
]);

function proofIdentityPolicy(type, field) {
  return PROOF_IDENTITY_PROVENANCE[`${type}.${field}`]
    || (type.startsWith('hook_') ? PROOF_IDENTITY_PROVENANCE[`hook_*.${field}`] : null);
}

function validateProofIdentityProvenance(state, type, payload) {
  if (state.privacy_mode !== 'proof') return;
  const governed = PROOF_IDENTITY_EVENT.has(type) || type.startsWith('hook_');
  if (!governed) return;
  for (const field of Object.keys(payload)) {
    if (!PROOF_IDENTITY_FIELD.test(field)) continue;
    const policy = proofIdentityPolicy(type, field);
    assert(policy && policy !== 'prose_derived_forbidden', 'UNREGISTERED_PROOF_IDENTITY_FIELD');
  }
  for (const [selector, policy] of Object.entries(PROOF_IDENTITY_PROVENANCE)) {
    if (policy !== 'prose_derived_forbidden') continue;
    const split = selector.lastIndexOf('.');
    const eventPattern = selector.slice(0, split);
    const field = selector.slice(split + 1);
    if (eventPattern === type || (eventPattern === 'hook_*' && type.startsWith('hook_'))) {
      assert(!Object.hasOwn(payload, field), 'PROSE_DERIVED_PROOF_IDENTITY');
    }
  }
}
const PRODUCER_TERMINAL_STATUSES = new Set(['CLEAN', 'FINDINGS', 'INVALID', 'STALE']);
const EVALUATION_TRIGGERS = new Set(['initial', 'post_fix_reeval', 'gate_audit', 're_examination']);
const LIFECYCLE_TRANSITION_TYPES = new Set([
  'child_started', 'child_stop_observed', 'child_receipt_sealed', 'child_receipt_retrieved',
  'evaluation_requested', 'evaluation_claimed', 'evaluation_finding', 'pr_refreshed'
]);
// An evaluation is terminal once its outcome is fixed: recorded, checkout-integrity excepted,
// or superseded by a moved head. Non-terminal (OPEN/CLAIMED) means a retry re-attaches; terminal
// means a fresh begin_evaluation on the same snapshot is a distinct re-examination.
export const TERMINAL_EVALUATION_STATUSES = new Set(['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION', 'STALE', 'INVALID']);

// An evaluation blocks a fresh same-snapshot begin_evaluation until it is FINISHED: dead-ended
// (STALE/INVALID), or recorded AND its evaluator child receipt sealed and retrieved — the same
// completion request_close requires. A retry arriving in the recording-to-retrieval gap therefore
// re-attaches to the unfinished evaluation instead of forking a second evaluator pass.
export function isEvaluationFinished(evaluation) {
  if (evaluation.status === 'STALE' || evaluation.status === 'INVALID') return true;
  if (!TERMINAL_EVALUATION_STATUSES.has(evaluation.status)) return false;
  return Boolean(evaluation.child_receipt_id && evaluation.child_receipt_retrieved);
}
const CAPABILITY_SHAPE = /^lyhna_(session|child)_[a-f0-9]{32,}$/;
const GIT_OBJECT_ID_SHAPE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function proofSafeGitObjectId(value) {
  return typeof value === 'string' && GIT_OBJECT_ID_SHAPE.test(value) ? value : null;
}

function assertCurrentCompiledBinding(state, payload, code) {
  const compiled = state.compiled_claim;
  assert(state.claim_contract && compiled, code);
  assert(payload.claim_contract_ref === state.claim_contract.claim_contract_ref, code);
  assert(payload.fold_version === CURRENT_FOLD_VERSION, code);
  assert(payload.input_digest === compiled.input_digest, code);
  assert(payload.eligible_evidence_frontier === compiled.eligible_evidence_frontier, code);
  assert(payload.material_control_frontier === compiled.material_control_frontier, code);
}

function validateCloseoutAttemptBinding(state, origin, payload, eventSeq = null) {
  const code = 'INVALID_CLOSEOUT_ATTEMPT';
  const ledgerEvents = parseLedger(state.id).events;
  const { bindingEvents, bindingState } = closeoutAttemptBindingState(state, eventSeq, ledgerEvents);
  assert(origin === 'runtime_hook' && bindingState.close_requested, code);
  assert(bindingState.claim_contract && bindingState.compiled_claim, code);
  assert(payload.claim_contract_ref === bindingState.claim_contract.claim_contract_ref, code);
  assert(payload.input_digest === bindingState.compiled_claim.input_digest, code);
  assert(payload.eligible_evidence_frontier === bindingState.compiled_claim.eligible_evidence_frontier, code);
  assert(payload.material_control_frontier === bindingState.compiled_claim.material_control_frontier, code);
  assert(
    payload.delivery_slot_ref === undefined || /^stop_slot_[a-f0-9]{64}$/.test(payload.delivery_slot_ref),
    code
  );
  assert(bindingState.claim_contract.declared_gate_ids.includes(payload.gate_id), code);
  const blockers = claimCloseoutBlockers(bindingState, bindingState.compiled_claim, bindingEvents);
  assert(blockers.length > 0, code);
  assert(canonicalJson(payload.blockers) === canonicalJson(blockers), code);
  assert(payload.blocker_fingerprint === claimCloseoutBlockerFingerprint(
    bindingState,
    payload.gate_id,
    bindingState.compiled_claim,
    bindingEvents
  ), code);
  const priorAttempts = ledgerEvents.filter((event) => (
    event.type === 'closeout_attempted'
    && event.origin === 'runtime_hook'
    && event.payload?.claim_contract_ref === bindingState.claim_contract.claim_contract_ref
    && (eventSeq === null || event.seq < eventSeq)
  ));
  const prior = priorAttempts.at(-1);
  const expectedOrdinal = closeoutAttemptStreakContinues(
    bindingState,
    ledgerEvents,
    prior,
    payload.blocker_fingerprint,
    payload.eligible_evidence_frontier,
    eventSeq
  )
    ? Number(prior.payload.ordinal || 0) + 1
    : 1;
  assert(payload.attempt_sequence === priorAttempts.length + 1, code);
  assert(payload.ordinal === expectedOrdinal, code);
}

function closeoutAttemptBindingState(state, eventSeq, ledgerEvents = parseLedger(state.id).events) {
  if (eventSeq === null) return { bindingEvents: ledgerEvents, bindingState: state };
  const bindingEvents = ledgerEvents.filter((event) => event.seq < eventSeq);
  return {
    bindingEvents,
    bindingState: { ...state, ...reconstructClaimControl(bindingEvents) }
  };
}

function closeoutAttemptStreakContinues(state, events, prior, fingerprint, eligibleEvidenceFrontier, beforeSeq = null) {
  if (!prior || prior.payload?.blocker_fingerprint !== fingerprint) return false;
  // Eligible evidence changes the effective support frontier. Ineligible observations remain
  // history but do not reset the cap, matching the compiler's primary/eligible firewall.
  if (prior.payload?.eligible_evidence_frontier !== eligibleEvidenceFrontier) return false;
  const baselineEvents = events.filter((event) => event.seq <= prior.seq);
  const intervening = events.filter((event) => (
    event.seq > prior.seq && (beforeSeq === null || event.seq < beforeSeq)
  ));
  const lifecycle = lifecycleProjectionFromEvents(baselineEvents);
  const producer = producerProjectionFromEvents(state, baselineEvents);
  const baselineLifecycle = canonicalJson(lifecycleBlockersFromProjection(state, lifecycle));
  const baselinePending = canonicalJson(pendingProducerIdsFromProjection(producer));
  // Replay each relevant projection once. This preserves exact A -> B -> A detection without
  // recompiling every ledger prefix (quadratic Stop latency on long but inert histories).
  for (const event of intervening) {
    const producerEvent = event.type === 'producer_requested' || event.type === 'producer_terminal';
    if (!producerEvent && !LIFECYCLE_TRANSITION_TYPES.has(event.type)) continue;
    applyLifecycleProjectionEvent(lifecycle, event);
    applyProducerProjectionEvent(state, producer, event);
    if (canonicalJson(lifecycleBlockersFromProjection(state, lifecycle)) !== baselineLifecycle) return false;
    if (canonicalJson(pendingProducerIdsFromProjection(producer)) !== baselinePending) return false;
  }
  return true;
}

function producerProjectionFromEvents(state, events) {
  const projection = { requested: new Set(), terminals: new Map() };
  for (const event of events) applyProducerProjectionEvent(state, projection, event);
  return projection;
}

function applyProducerProjectionEvent(state, projection, event) {
  const payload = event.payload || {};
  const producer = state.claim_profile?.producers?.[payload.producer_id];
  const bound = Boolean(
    producer
    && state.claim_contract?.named_producers?.includes(payload.producer_id)
    && payload.contract_id === state.claim_contract.contract_id
    && payload.claim_contract_ref === state.claim_contract.claim_contract_ref
  );
  if (event.type === 'producer_requested' && event.origin === 'mcp_routed'
    && bound && payload.expected_identity === producer.expected_identity) {
    projection.requested.add(payload.producer_id);
  } else if (event.type === 'producer_terminal' && event.origin === 'runtime_hook'
    && bound && payload.producer_identity === producer.expected_identity) {
    projection.terminals.set(payload.producer_id, payload.status);
  }
}

function pendingProducerIdsFromProjection(projection) {
  return [...projection.requested]
    .filter((producerId) => projection.terminals.get(producerId) !== 'CLEAN')
    .sort();
}

function validateCloseoutEnvelopeBinding(state, origin, payload) {
  const code = 'INVALID_CLOSEOUT_ENVELOPE';
  assert(origin === 'runtime_hook', code);
  const required = [
    'envelope_id', 'outcome', 'profile_id', 'requested_state', 'supported_state',
    'scope_ref', 'eligible_evidence_frontier', 'material_control_frontier', 'input_digest',
    'claim_contract_ref', 'fold_version', 'blockers', 'next_verifier'
  ];
  assert(required.every((key) => Object.hasOwn(payload, key)), code);
  assert(typeof payload.envelope_id === 'string' && payload.envelope_id.length > 0, code);
  assert(Array.isArray(payload.blockers) && payload.blockers.every((item) => typeof item === 'string'), code);
  assert(payload.outcome === 'SUPPORTED' || payload.outcome === 'CLOSED_UNSUPPORTED', code);
  if (payload.outcome === 'SUPPORTED') {
    assertCurrentCompiledBinding(state, payload, code);
    assert(payload.profile_id === state.claim_contract.profile_id, code);
    assert(payload.requested_state === state.claim_contract.requested_state, code);
    assert(payload.supported_state === state.compiled_claim.highest_supported_state, code);
    assert(payload.scope_ref === state.claim_contract.objective_ref, code);
    assert(payload.next_verifier === state.compiled_claim.next_verifier, code);
    assert(state.close_requested, code);
    assert(state.compiled_claim.state_results?.[state.claim_contract.requested_state]?.supported === true, code);
    assert(state.compiled_claim.currentness === 'AS_WITNESSED', code);
    assert(state.compiled_claim.pending_producers.length === 0, code);
    assert(state.compiled_claim.contradictions.length === 0, code);
    // A durable envelope replay is still a closeout. Re-evaluate the same ledger-derived join
    // predicate used by the ordinary path so an envelope cannot outlive a newly-open child,
    // evaluator, or corrupted/missing child receipt artifact.
    assert(claimCloseoutBlockers(state, state.compiled_claim).length === 0, code);
    assert(payload.blockers.length === 0, code);
  } else {
    const attempts = parseLedger(state.id).events.filter((event) => (
      event.type === 'closeout_attempted'
      && event.origin === 'runtime_hook'
      && event.payload?.claim_contract_ref === state.claim_contract.claim_contract_ref
    ));
    const boundAttempt = [...attempts].reverse().find((event) => (
      event.payload?.ordinal === state.claim_contract.caps.max_unsupported_attempts
      && event.payload?.input_digest === payload.input_digest
      && event.payload?.eligible_evidence_frontier === payload.eligible_evidence_frontier
      && event.payload?.material_control_frontier === payload.material_control_frontier
      && canonicalJson(event.payload?.blockers) === canonicalJson(payload.blockers)
    ));
    assert(boundAttempt, code);
    validateCloseoutAttemptBinding(state, boundAttempt.origin, boundAttempt.payload, boundAttempt.seq);
    const { bindingEvents, bindingState } = closeoutAttemptBindingState(state, boundAttempt.seq);
    assertCurrentCompiledBinding(bindingState, payload, code);
    assert(payload.profile_id === bindingState.claim_contract.profile_id, code);
    assert(payload.requested_state === bindingState.claim_contract.requested_state, code);
    assert(payload.supported_state === bindingState.compiled_claim.highest_supported_state, code);
    assert(payload.scope_ref === bindingState.claim_contract.objective_ref, code);
    assert(payload.next_verifier === bindingState.compiled_claim.next_verifier, code);
    assert(bindingState.close_requested, code);
    const blockers = claimCloseoutBlockers(bindingState, bindingState.compiled_claim, bindingEvents);
    assert(blockers.length > 0 && canonicalJson(payload.blockers) === canonicalJson(blockers), code);
    assert(boundAttempt.payload.ordinal === bindingState.claim_contract.caps.max_unsupported_attempts, code);
  }
}

function root() {
  const value = dataRoot();
  mkdirSync(value, { recursive: true });
  return value;
}

function masterKey() {
  const path = join(root(), 'master.key');
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return readFileSync(path);
}

function deriveCapability(kind, ...parts) {
  return `lyhna_${kind}_${createHmac('sha256', masterKey()).update(parts.join('\0')).digest('hex')}`;
}

function capabilityPath(capability) {
  return join(root(), 'capabilities', `${sha256(capability)}.json`);
}

function activePath(capability) {
  return join(root(), 'active', `${sha256(capability)}.json`);
}

function runDir(runId) {
  return join(root(), 'runs', runId);
}

function childReceiptPath(runId, receiptId) {
  return join(runDir(runId), 'child-receipts', receiptId, 'receipt.json');
}

function withChildReceiptPath(runId, receipt) {
  return { ...receipt, path: childReceiptPath(runId, receipt.id) };
}

function statePath(runId) {
  return join(runDir(runId), 'state.json');
}

function ledgerPath(runId) {
  return join(runDir(runId), 'events.jsonl');
}

function lockPath(runId) {
  return join(runDir(runId), '.lock');
}

function anchorPath(runId) {
  return join(runDir(runId), 'seal-anchor.json');
}

function checkpointAnchorPath(runId) {
  return join(runDir(runId), 'checkpoint-anchor.json');
}

function receiptIndexPath(receiptId) {
  return join(root(), 'receipt-index', `${sha256(receiptId)}.json`);
}

// The window-handoff artifacts: what the NEXT context window inherits from this run.
//
// Deliberately NOT anchored by hash the way the receipt is. Both files are pure, deterministic
// projections of (state, ledger), so the lineage checker re-FOLDS them from the chain instead of
// comparing a stored hash. Re-folding is the stronger check: a hash comparison only catches an
// edited file, while a re-fold also catches a file regenerated wholesale with a matching hash.
// Keeping them out of the anchor payload also preserves read-compat with packets sealed by an
// earlier renderer, whose anchors have no such fields.
function writeContinuationArtifacts(runId, state, events, foldVersion = CURRENT_FOLD_VERSION) {
  const capsule = buildContinuation(state, events, foldVersion);
  // Signing is best-effort at the artifact layer: a machine that cannot mint or read a key still
  // gets a complete, verifiable-by-hash packet. An UNSIGNED capsule is honest; a packet that
  // silently failed to write would not be.
  let published = capsule;
  try {
    published = signCapsule(capsule, loadOrCreateKeypair());
  } catch {
    published = capsule;
  }
  // Archive this fold immutably under its own ref. continuation.json is the run's CURRENT face and
  // is overwritten by every later Stop — so a handoff taken at Stop N stopped resolving the moment
  // Stop N+1 ran, and a successor holding that exact ref recorded UNRESOLVED_LOCALLY. The archive
  // is self-authenticating: the ref is content-addressed, so a file here either hashes to its own
  // name or it is not that capsule. Never overwritten — immutability is the point.
  const archivePath = capsuleArchivePath(runId, published.capsule_ref);
  if (!existsSync(archivePath)) atomicWriteText(archivePath, canonicalJson(published, true));
  // Make the archive resolvable before publishing the current face or handoff. A crash after a
  // visible handoff but before its index used to let a successor fork an open contract as an
  // unrelated UNRESOLVED_LOCALLY run. An early index is safe: until the archive exists resolution
  // fails closed, while no caller can observe a new ref before continuation.json is replaced.
  atomicWriteJson(capsuleIndexPath(published.capsule_ref), { run_id: runId, capsule_ref: published.capsule_ref });
  atomicWriteText(join(runDir(runId), 'continuation.json'), canonicalJson(published, true));
  atomicWriteText(join(runDir(runId), 'HANDOFF.md'), renderHandoffMarkdown(published));
  return published;
}

/**
 * Repair the Stop artifact tail on a replayed delivery. The anchor event proves the packet was
 * anchored — not that the artifacts after it landed. Writes archive → index → continuation → handoff, so
 * a crash anywhere in that tail leaves a packet the anchor declares complete and nothing else would
 * ever repair: a missing index strands the successor at UNRESOLVED_LOCALLY, and a missing capsule
 * or handoff breaks the SPEC promise that every observed Stop leaves a verifiable handoff.
 *
 * Regeneration folds under the generation the CHAIN commits to, never blindly with current code —
 * repairing a packet whose anchor names an older fold with today's reducer would republish a
 * capsule its own ledger no longer refolds to. A fold this build cannot place is left alone: a
 * wrong repair is worse than a missing file, which at least reports honestly.
 */
function ensureStopArtifacts(runId, state) {
  const dir = runDir(runId);
  const capsulePath = join(dir, 'continuation.json');
  const handoffPath = join(dir, 'HANDOFF.md');
  const { events } = parseLedger(runId);
  const anchor = events.find((event) => event.type === 'run_sealed')
    ?? [...events].reverse().find((event) => event.type === 'checkpoint_anchor');
  const published = existsSync(capsulePath) ? readJson(capsulePath, null) : null;
  const publishedValid = Boolean(published?.capsule_ref && deriveCapsuleRef(published) === published.capsule_ref);
  // PRESENCE is not CURRENCY. A crash after Stop N's anchor but before its face overwrite leaves
  // Stop N-1's capsule sitting where N's should be — a file that exists, self-validates, and is
  // still the wrong face: lineage re-folds the full ledger and reports the packet tampered. The
  // face is current only if the fold boundary it commits to IS the ledger tip.
  const publishedCurrent = publishedValid
    && published.witnessed?.event_count === events.length
    && published.witnessed?.ledger_tip === events.at(-1)?.event_hash;

  if (!publishedCurrent) {
    // Preserve a genuine older face before replacing it: if its committed tip sits at exactly the
    // position it names in this chain, it is a real fold of this ledger and handoffs taken from it
    // must keep resolving. Archive and index it — never destroy it.
    if (publishedValid) {
      const staleCount = published.witnessed?.event_count;
      const genuine = Number.isInteger(staleCount)
        && staleCount >= 1
        && staleCount <= events.length
        && events[staleCount - 1]?.event_hash === published.witnessed?.ledger_tip;
      if (genuine) {
        const staleArchive = capsuleArchivePath(runId, published.capsule_ref);
        if (!existsSync(staleArchive)) atomicWriteText(staleArchive, canonicalJson(published, true));
        if (!readJson(capsuleIndexPath(published.capsule_ref), null)) {
          atomicWriteJson(capsuleIndexPath(published.capsule_ref), { run_id: runId, capsule_ref: published.capsule_ref });
        }
      }
    }
    // Regenerate ONLY at the anchored boundary. A capsule is a Stop artifact: if the ledger has
    // advanced past the anchor before the replay arrived, folding the full current ledger would
    // publish post-Stop activity no Stop observed or anchored — a capsule the packet's own history
    // cannot account for. The next real Stop will fold and anchor everything; until then a stale or
    // missing file that reports honestly beats a fabricated boundary. For a checkpoint the current
    // state must also be the exact state the anchor committed, or the fold's inputs are not the
    // ones the chain vouches for.
    if (!anchor || events.at(-1) !== anchor) return;
    if (anchor.type === 'checkpoint_anchor') {
      // The anchor committed the state as it stood BEFORE the anchor event was appended (the
      // append advances ledger_count/tip as pure bookkeeping). Roll those two fields back to the
      // anchor's position and compare: a mismatch means the state itself changed since the Stop,
      // and folding it would publish inputs the chain never vouched for.
      const preAnchor = {
        ...state,
        ledger_count: anchor.payload.covers_seq,
        ledger_tip: anchor.payload.covers_seq === 0 ? ZERO_HASH : events[anchor.payload.covers_seq - 1]?.event_hash
      };
      if (anchor.payload?.state_hash !== sha256(canonicalJson(preAnchor))) return;
    }
    // The gate above proves the state is semantically the one the anchor committed — but a crash
    // between the anchor append and saveState leaves the CACHE one write behind, still carrying
    // pre-anchor count/tip. Folding with that lag publishes a capsule whose witnessed bookkeeping
    // excludes the anchor, and it stops refolding the moment any normal read advances state.json
    // to the ledger tip: an untampered packet aging into a tamper report. Advance the two fields
    // over the anchor — the same prefix recovery the next real Stop would perform.
    const foldState = { ...state, ledger_count: events.length, ledger_tip: events.at(-1).event_hash };
    let fold = anchor?.payload?.continuation_fold_version;
    if (fold === undefined) {
      // A renderer string may span more than one shipped shape (0.1.30). With no current face
      // there are no bytes to match against, so an ambiguous candidate set means the repair cannot
      // know which shape to regenerate — and a wrong repair is worse than an honest gap. Repair
      // only when the generation is unambiguous.
      const candidates = foldCandidatesForRenderer(anchor?.payload?.receipt_renderer);
      if (!candidates || candidates.length !== 1) return;
      fold = candidates[0];
    }
    if (!KNOWN_FOLD_VERSIONS.includes(fold)) return;
    writeContinuationArtifacts(runId, foldState, events, fold);
    return;
  }
  const ref = published.capsule_ref;
  const archivePath = capsuleArchivePath(runId, ref);
  if (!existsSync(archivePath)) atomicWriteText(archivePath, canonicalJson(published, true));
  if (!readJson(capsuleIndexPath(ref), null)) {
    atomicWriteJson(capsuleIndexPath(ref), { run_id: runId, capsule_ref: ref });
  }
  if (!existsSync(handoffPath)) atomicWriteText(handoffPath, renderHandoffMarkdown(published));
}

// A capsule_ref -> run_id index, so a run started in a LATER session (a new window is a new
// session_id) can resolve the predecessor it names. Mirrors the receipt index.
function capsuleIndexPath(capsuleRef) {
  return join(root(), 'capsule-index', `${sha256(capsuleRef)}.json`);
}

/** The immutable per-fold archive inside the run packet, keyed by content-addressed ref. */
function capsuleArchivePath(runId, capsuleRef) {
  return join(runDir(runId), 'capsules', `${capsuleRef}.json`);
}

/**
 * Resolve a declared predecessor against what this store can actually see.
 *
 * The state_hash recorded in the inherits edge is READ FROM THE PRIOR PACKET, never accepted from
 * the caller. An agent can therefore name a predecessor, but it cannot fabricate what that
 * predecessor's carry-forward state was — the commitment sealed into this run's chain either
 * matches the prior packet or the lineage check fails.
 *
 * A never-seen ref is recorded as UNRESOLVED: the packet may live on another machine. Once this
 * store indexed a ref, losing the packet or archive fails closed. The index is only a locator, not
 * trusted proof of whether the missing run was sealed; accepting mutable status metadata here
 * would let a corrupted open-contract index fork a second writable history.
 */
function resolveContinuesFrom(capsuleRef) {
  const ref = String(capsuleRef || '').trim();
  if (!ref) return null;
  const indexPath = capsuleIndexPath(ref);
  const indexExists = existsSync(indexPath);
  const indexed = readJson(indexPath, null);
  const priorRunId = indexed?.run_id;
  const published = priorRunId ? readJson(join(runDir(priorRunId), 'continuation.json'), null) : null;
  if (published && published.capsule_ref === ref && deriveCapsuleRef(published) === ref) {
    return {
      capsule_ref: ref,
      run_id: priorRunId,
      state_hash: published.state_hash,
      resolution: 'RESOLVED_LOCAL_PACKET'
    };
  }
  // The run's current face has moved past this ref (a later Stop re-folded), but the fold itself
  // is archived immutably under its content-addressed name. A ref whose archived bytes hash to the
  // name IS that capsule — resolving from the archive invents nothing, and refusing to would strand
  // every handoff taken before a run's final Stop.
  const archived = priorRunId ? readJson(capsuleArchivePath(priorRunId, ref), null) : null;
  if (archived && archived.capsule_ref === ref && deriveCapsuleRef(archived) === ref && archived.run_id === priorRunId) {
    return {
      capsule_ref: ref,
      run_id: priorRunId,
      state_hash: archived.state_hash,
      resolution: 'RESOLVED_LOCAL_ARCHIVE'
    };
  }
  if (indexExists) {
    return { capsule_ref: ref, run_id: priorRunId, state_hash: null, resolution: 'LOCAL_PREDECESSOR_UNAVAILABLE' };
  }
  return { capsule_ref: ref, run_id: null, state_hash: null, resolution: 'UNRESOLVED_LOCALLY' };
}

function sessionLockPath(capability) {
  return join(root(), 'session-locks', `${sha256(capability)}.lock`);
}

function continuationLockPath() {
  return join(root(), 'continuation-transfer.lock');
}

function activePathByCapabilityHash(capabilityHash) {
  return join(root(), 'active', `${capabilityHash}.json`);
}

function migratedChildRoutePath(sessionHash, agentHash) {
  return join(root(), 'migrated-child-routes', `${sessionHash}-${agentHash}.json`);
}

function sessionRunsPath(sessionHash) {
  return join(root(), 'session-runs', `${sessionHash}.json`);
}

function claimRejectedMarkerPath(capabilityRef) {
  return join(root(), 'claim-rejected', `claim-${capabilityRef.slice(0, 16)}.json`);
}

function verifyChildReceipts(state) {
  for (const receipt of Object.values(state.child_receipts || {})) {
    const path = childReceiptPath(state.id, receipt.id);
    assert(receipt.content_hash && existsSync(path), 'LOCAL_CHAIN_BROKEN');
    assert(sha256(readFileSync(path, 'utf8')) === receipt.content_hash, 'LOCAL_CHAIN_BROKEN');
  }
}

function writeCapability(capability, record) {
  atomicWriteJson(capabilityPath(capability), { ...record, capability_hash: sha256(capability) });
}

export function getCapability(capability) {
  assert(typeof capability === 'string' && capability.length > 20, 'INVALID_CAPABILITY');
  const record = readJson(capabilityPath(capability), null);
  assert(record && record.capability_hash === sha256(capability), 'UNKNOWN_CAPABILITY');
  return record;
}

export function mintSession({ sessionId, cwd = '', model = '' }) {
  assert(sessionId, 'MISSING_SESSION_ID');
  const sessionHash = sha256(String(sessionId));
  const capability = deriveCapability('session', sessionHash);
  const existing = readJson(capabilityPath(capability), null);
  if (!existing) {
    writeCapability(capability, {
      kind: 'parent',
      session_hash: sessionHash,
      cwd_ref: cwd ? reference(String(cwd)) : null,
      model: boundedText(model, 100) || null
    });
  }
  return capability;
}

export function mintChild({ sessionId, agentId, hookPayload = null, hookDeliveryKey = null }) {
  assert(sessionId, 'MISSING_SESSION_ID');
  assert(agentId, 'MISSING_AGENT_ID');
  const parentCapability = deriveCapability('session', sha256(String(sessionId)));
  const parent = getCapability(parentCapability);
  const activeRunId = activeRunFor(parentCapability);
  if (!activeRunId) return null;
  const agentHash = sha256(String(agentId));
  const capability = deriveCapability('child', parent.session_hash, activeRunId, agentHash);
  withLock(lockPath(activeRunId), () => {
    const current = loadState(activeRunId);
    recoverClaimControlStateUnlocked(activeRunId, current);
    assert(!current.sealed, 'RUN_SEALED');
    assert(current.parent_capability_hash === sha256(parentCapability), 'CAPABILITY_RUN_MISMATCH');
    if (!readJson(capabilityPath(capability), null)) {
      writeCapability(capability, {
        kind: 'child',
        agent_hash: agentHash,
        parent_capability_hash: sha256(parentCapability),
        parent_run_id: activeRunId
      });
    }
    let startEvent = null;
    if (hookPayload) {
      assert(current.privacy_mode !== 'proof' || /^hook:[^:]+:id_[a-f0-9]{64}$/.test(String(hookDeliveryKey || '')), 'PROOF_HOOK_DELIVERY_ID_REQUIRED');
      startEvent = appendEventUnlocked(activeRunId, current, {
        type: 'hook_subagentstart',
        origin: 'runtime_hook',
        payload: hookPayload,
        idempotencyKey: hookDeliveryKey || `hook:SubagentStart:${sha256(canonicalJson(hookPayload))}`
      });
    }
    current.children ||= {};
    if (!current.children[agentHash]) {
      const childId = `child_agent_${sha256(`${activeRunId}\0${agentHash}`).slice(0, 24)}`;
      const childStartedEvent = appendEventUnlocked(activeRunId, current, {
        type: 'child_started',
        origin: 'runtime_hook',
        payload: { child_id: childId, role: 'delegated_agent', status: 'STARTED' },
        idempotencyKey: `child-start:${childId}`
      });
      current.children[agentHash] = {
        id: childId,
        role: 'delegated_agent',
        status: 'STARTED',
        start_event_ref: startEvent?.event_hash || childStartedEvent.event_hash,
        stop_event_ref: null,
        receipt_id: null
      };
    }
    saveState(current);
  });
  return capability;
}

export function findParentCapabilityBySession(sessionId) {
  if (!sessionId) return null;
  const capability = deriveCapability('session', sha256(String(sessionId)));
  return readJson(capabilityPath(capability), null) ? capability : null;
}

export function activeRunFor(capability, { includeSealed = false } = {}) {
  const record = readJson(activePath(capability), null);
  if (!record?.run_id) return null;
  const state = readJson(statePath(record.run_id), null);
  if (!includeSealed && state?.sealed && existsSync(anchorPath(record.run_id))) return null;
  return record.run_id;
}

function locateOpenClaimRunForParent(capability) {
  const active = activeRunFor(capability);
  if (active) return active;
  const parent = getCapability(capability);
  assert(parent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  const callerRef = sha256(capability);
  const index = readJson(sessionRunsPath(parent.session_hash), { run_ids: [] });
  for (const runId of [...(index.run_ids || [])].reverse()) {
    try {
      const parsed = parseLedger(runId);
      if (parsed.events.some((event) => event.type === 'run_sealed')) continue;
      if (!parsed.events.some((event) => event.type === 'claim_contract_declared')) continue;
      const lease = [...parsed.events].reverse().find((event) => event.type === 'continuation_lease_transferred');
      if (lease) {
        if (lease.payload?.successor_parent_ref !== callerRef) continue;
      } else {
        const cached = readJson(statePath(runId), null);
        if (cached?.parent_capability_hash && cached.parent_capability_hash !== callerRef) continue;
      }
      return runId;
    } catch {
      const cached = readJson(statePath(runId), null);
      if (cached?.claim_contract && !cached.sealed && cached.parent_capability_hash === callerRef) return runId;
    }
  }
  return null;
}

function loadState(runId) {
  const state = readJson(statePath(runId), null);
  assert(state, 'RUN_NOT_FOUND');
  return state;
}

function stripLegacyChildReceiptPaths(state) {
  for (const receipt of Object.values(state.child_receipts || {})) delete receipt.path;
}

function saveState(state) {
  if (!state.sealed) stripLegacyChildReceiptPaths(state);
  atomicWriteJson(statePath(state.id), state);
}

function parseLedger(runId) {
  const path = ledgerPath(runId);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const events = [];
  let previous = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      throw Object.assign(new Error('LOCAL_CHAIN_BROKEN: invalid JSON'), { code: 'LOCAL_CHAIN_BROKEN' });
    }
    const claimed = event.event_hash;
    const withoutHash = { ...event };
    delete withoutHash.event_hash;
    const expected = sha256(canonicalJson(withoutHash));
    assert(event.seq === index + 1 && event.prev_hash === previous && claimed === expected, 'LOCAL_CHAIN_BROKEN');
    previous = claimed;
    events.push(event);
  }
  return { events, tip: previous };
}

function reconstructClaimControl(events) {
  const contractEvent = events.find((event) => event.type === 'claim_contract_declared');
  const contractRef = contractEvent ? `sha256:${contractEvent.event_hash}` : null;
  const compiledBindings = events.filter((event) => (
    event.type === 'claim_compiled'
    && event.origin === 'runtime_hook'
    && event.payload?.claim_contract_ref === contractRef
    && event.payload?.fold_version === CURRENT_FOLD_VERSION
  ));
  const diagnosticIsBound = (event) => {
    if (event.origin !== 'runtime_hook'
      || event.payload?.claim_contract_ref !== contractRef
      || event.payload?.fold_version !== CURRENT_FOLD_VERSION
      || typeof event.payload?.diagnostic_id !== 'string'
      || typeof event.payload?.blocker_fingerprint !== 'string') return false;
    const expectedStatus = event.type === 'diagnostic_emitted' ? 'OPEN' : 'RESOLVED';
    if (event.payload?.diagnostic_status !== expectedStatus) return false;
    return compiledBindings.some((compiled) => (
      compiled.seq < event.seq
      && compiled.payload?.input_digest === event.payload?.input_digest
      && compiled.payload?.eligible_evidence_frontier === event.payload?.eligible_evidence_frontier
      && compiled.payload?.material_control_frontier === event.payload?.material_control_frontier
    ));
  };
  const compiledEvent = compiledBindings.at(-1);
  const emitted = new Map();
  for (const event of events) {
    if (event.type === 'diagnostic_emitted' && diagnosticIsBound(event)) {
      emitted.set(event.payload?.diagnostic_id, {
        diagnostic_id: event.payload?.diagnostic_id,
        status: event.payload?.diagnostic_status || 'OPEN',
        input_digest: event.payload?.input_digest,
        event_seq: event.seq,
        ...(event.payload?.blocker_fingerprint ? { blocker_fingerprint: event.payload.blocker_fingerprint } : {})
      });
    } else if (event.type === 'diagnostic_resolved' && diagnosticIsBound(event) && emitted.has(event.payload?.diagnostic_id)) {
      emitted.set(event.payload.diagnostic_id, {
        ...emitted.get(event.payload.diagnostic_id),
        status: 'RESOLVED',
        input_digest: event.payload?.input_digest,
        event_seq: event.seq
      });
    }
  }
  let latestDiagnostic = [...emitted.values()].at(-1) || null;
  const latestAttempt = [...events].reverse().find((event) => event.type === 'closeout_attempted');
  if (latestAttempt && (!latestDiagnostic || latestAttempt.seq > latestDiagnostic.event_seq)) {
    latestDiagnostic = [...emitted.values()].reverse().find((item) => (
      item.blocker_fingerprint === latestAttempt.payload?.blocker_fingerprint
    )) || latestDiagnostic;
  }
  if (latestDiagnostic) {
    const attempt = [...events].reverse().find((event) => (
      event.type === 'closeout_attempted' && event.payload?.input_digest === latestDiagnostic.input_digest
    ));
    if (attempt?.payload?.blocker_fingerprint) latestDiagnostic.blocker_fingerprint = attempt.payload.blocker_fingerprint;
    delete latestDiagnostic.event_seq;
  }
  const envelopeEvent = [...events].reverse().find((event) => event.type === 'closeout_envelope_generated');
  const closeEvent = [...events].reverse().find((event) => event.type === 'close_requested');
  const leaseEvent = [...events].reverse().find((event) => event.type === 'continuation_lease_transferred');
  const sealEvent = events.find((event) => event.type === 'run_sealed');
  const compiledPayload = compiledEvent ? { ...compiledEvent.payload } : null;
  if (compiledPayload) delete compiledPayload.fold_version;
  return {
    claim_contract: contractEvent?.payload?.contract
      ? { ...contractEvent.payload.contract, claim_contract_ref: `sha256:${contractEvent.event_hash}` }
      : null,
    claim_profile: contractEvent?.payload?.profile_structural ?? null,
    compiled_claim: compiledEvent
      ? { ...compiledPayload, claim_contract_ref: compiledEvent.payload?.claim_contract_ref, compiled_event_ref: `sha256:${compiledEvent.event_hash}` }
      : null,
    claim_diagnostic: latestDiagnostic,
    closeout_envelope: envelopeEvent ? { ...envelopeEvent.payload, event_ref: `sha256:${envelopeEvent.event_hash}` } : null,
    close_requested: closeEvent?.payload ?? null,
    terminal_status: sealEvent?.payload?.status ?? null,
    continuation_lease: leaseEvent ? {
      capsule_ref: leaseEvent.payload?.capsule_ref,
      predecessor_parent_ref: leaseEvent.payload?.predecessor_parent_ref,
      successor_parent_ref: leaseEvent.payload?.successor_parent_ref
    } : null,
    lease_event: leaseEvent || null
  };
}

function recoverClaimControlStateUnlocked(runId, state, parsed = parseLedger(runId)) {
  assert(Number.isInteger(state.ledger_count) && state.ledger_count >= 0 && state.ledger_count <= parsed.events.length, 'LOCAL_CHAIN_BROKEN');
  const prefixTip = state.ledger_count === 0 ? ZERO_HASH : parsed.events[state.ledger_count - 1]?.event_hash;
  assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  const lagging = state.ledger_count < parsed.events.length;
  const rebuilt = reconstructClaimControl(parsed.events);
  const fields = ['claim_contract', 'claim_profile', 'compiled_claim', 'claim_diagnostic', 'closeout_envelope', 'close_requested', 'continuation_lease'];
  if (!lagging) {
    let repaired = reconcileLifecycleProjectionUnlocked(state, parsed.events);
    for (const field of fields) {
      if ((state[field] === null || state[field] === undefined) && rebuilt[field] !== null) {
        state[field] = rebuilt[field];
        repaired = true;
      } else {
        assert(canonicalJson(state[field] ?? null) === canonicalJson(rebuilt[field] ?? null), `LOCAL_CHAIN_BROKEN:${field}`);
      }
    }
    if ((state.terminal_status === null || state.terminal_status === undefined) && rebuilt.terminal_status) {
      state.terminal_status = rebuilt.terminal_status;
      repaired = true;
    } else if (state.claim_contract || state.terminal_status !== undefined) {
      assert((state.terminal_status ?? null) === rebuilt.terminal_status, 'LOCAL_CHAIN_BROKEN');
    }
    if (repaired) saveState(state);
    if (rebuilt.lease_event) assert(state.parent_capability_hash === rebuilt.lease_event.payload?.successor_parent_ref, 'LOCAL_CHAIN_BROKEN');
  } else {
    for (const field of fields) state[field] = rebuilt[field];
    if (rebuilt.terminal_status) state.terminal_status = rebuilt.terminal_status;
    if (rebuilt.lease_event) {
      state.parent_capability_hash = rebuilt.lease_event.payload.successor_parent_ref;
      state.continuation_lease = rebuilt.continuation_lease;
    }
    reconcileLifecycleProjectionUnlocked(state, parsed.events);
    state.ledger_count = parsed.events.length;
    state.ledger_tip = parsed.tip;
    saveState(state);
  }
  return { ...parsed, rebuilt };
}

function reconcileLifecycleProjectionUnlocked(state, events) {
  const priorChildren = state.children || {};
  const priorEvaluations = state.evaluations || {};
  const priorReceipts = state.child_receipts || {};
  const capabilityRecords = [];
  const capabilityDir = join(root(), 'capabilities');
  if (existsSync(capabilityDir)) {
    for (const entry of readdirSync(capabilityDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const capabilityRef = entry.name.slice(0, -'.json'.length);
      const record = readJson(join(capabilityDir, entry.name), null);
      if (record?.kind === 'child'
        && record.parent_run_id === state.id
        && record.capability_hash === capabilityRef) {
        capabilityRecords.push(record);
      }
    }
  }
  const childEvents = new Map();
  const evaluationEvents = new Map();
  const receiptEvents = new Map();
  const retrieved = new Map();
  const staleSnapshots = new Set();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === 'child_started' && event.origin === 'runtime_hook') {
      childEvents.set(payload.child_id, {
        ...childEvents.get(payload.child_id),
        id: payload.child_id,
        role: payload.role,
        status: 'STARTED',
        start_event_ref: event.event_hash,
        stop_event_ref: null,
        receipt_id: null
      });
    } else if (event.type === 'child_stop_observed' && event.origin === 'runtime_hook') {
      const child = childEvents.get(payload.child_id);
      if (child) Object.assign(child, { role: payload.role, status: 'STOP_OBSERVED', stop_event_ref: event.event_hash });
    } else if (event.type === 'evaluation_requested' && event.origin === 'mcp_routed') {
      const prior = priorEvaluations[payload.evaluation_request_id] || {};
      evaluationEvents.set(payload.evaluation_request_id, {
        ...prior,
        id: payload.evaluation_request_id,
        snapshot_id: payload.snapshot_id,
        expected_head: payload.expected_head,
        status: 'OPEN',
        trigger: payload.trigger,
        child_capability_hash: null,
        child_agent_hash: null,
        child_receipt_id: null,
        child_receipt_retrieved: false,
        findings: []
      });
    } else if (event.type === 'evaluation_claimed' && event.origin === 'mcp_routed') {
      const evaluation = evaluationEvents.get(payload.evaluation_request_id);
      const capability = capabilityRecords.find((record) => record.agent_hash === payload.child_agent_hash);
      if (evaluation) Object.assign(evaluation, {
        status: 'CLAIMED',
        child_agent_hash: payload.child_agent_hash,
        child_capability_hash: capability?.capability_hash || null
      });
    } else if (event.type === 'evaluation_finding' && event.origin === 'evaluator_reported') {
      const evaluation = evaluationEvents.get(payload.evaluation_request_id);
      if (evaluation) {
        evaluation.status = payload.checkout_integrity === 'CONSISTENT_CLEAN' && evaluation.status !== 'CHECKOUT_INTEGRITY_EXCEPTION'
          ? 'RECORDED'
          : 'CHECKOUT_INTEGRITY_EXCEPTION';
        evaluation.findings ||= [];
        if (!evaluation.findings.some((finding) => sha256(canonicalJson(finding)) === sha256(canonicalJson(payload)))) evaluation.findings.push(payload);
        for (const key of ['expected_head', 'checkout_head_before', 'checkout_head_after', 'checkout_clean_before', 'checkout_clean_after', 'checkout_detached_before', 'checkout_detached_after']) {
          if (Object.hasOwn(payload, key)) evaluation[key] = payload[key];
        }
      }
    } else if (event.type === 'pr_refreshed' && event.origin === 'github_observed' && payload.status === 'STALE') {
      staleSnapshots.add(payload.snapshot_id);
    } else if (event.type === 'child_receipt_sealed' && event.origin === 'runtime_hook') {
      receiptEvents.set(payload.receipt_id, {
        id: payload.receipt_id,
        role: payload.role,
        status: payload.status,
        content_hash: payload.content_ref,
        retrieved: false
      });
    } else if (event.type === 'child_receipt_retrieved' && event.origin === 'mcp_routed') {
      retrieved.set(payload.receipt_id, payload.content_ref);
    }
  }
  for (const [receiptId, receipt] of receiptEvents) {
    receipt.retrieved = retrieved.get(receiptId) === receipt.content_hash
  }
  for (const evaluation of evaluationEvents.values()) {
    if (staleSnapshots.has(evaluation.snapshot_id)) evaluation.status = 'STALE';
    const receiptId = `child_${evaluation.id}`;
    const receipt = receiptEvents.get(receiptId);
    if (receipt) {
      evaluation.child_receipt_id = receiptId;
      receipt.retrieved = retrieved.get(receiptId) === receipt.content_hash;
      evaluation.child_receipt_retrieved = receipt.retrieved;
    }
  }
  const children = {};
  for (const [childId, eventChild] of childEvents) {
    const priorEntry = Object.entries(priorChildren).find(([, child]) => child.id === childId);
    const capability = capabilityRecords.find((record) => `child_agent_${sha256(`${state.id}\0${record.agent_hash}`).slice(0, 24)}` === childId);
    const agentHash = capability?.agent_hash || priorEntry?.[0] || `agent_${sha256(childId).slice(0, 24)}`;
    const child = { ...(priorEntry?.[1] || {}), ...eventChild };
    const evaluation = [...evaluationEvents.values()].find((item) => (
      item.child_agent_hash
      && `child_agent_${sha256(`${state.id}\0${item.child_agent_hash}`).slice(0, 24)}` === childId
    ));
    // A stale or otherwise non-recordable evaluation can still finish as an ordinary
    // lifecycle child. Prefer the evaluation receipt only when that durable receipt
    // actually exists; never manufacture its identity from cached assignment state.
    const evaluationReceiptId = evaluation ? `child_${evaluation.id}` : null;
    const receiptId = evaluationReceiptId && receiptEvents.has(evaluationReceiptId)
      ? evaluationReceiptId
      : childId;
    if (evaluation) child.role = 'evaluator';
    if (receiptEvents.has(receiptId)) {
      child.receipt_id = receiptId;
      child.role = receiptEvents.get(receiptId).role || child.role;
    }
    children[agentHash] = child;
  }
  if (process.env.DEBUG_LYHNA) console.error('DEBUG_RECON', [...retrieved], [...receiptEvents]);
  const childReceipts = Object.fromEntries(receiptEvents);
  state.children = children;
  state.evaluations = Object.fromEntries(evaluationEvents);
  state.child_receipts = childReceipts;
  return canonicalJson({ children: priorChildren, evaluations: priorEvaluations, child_receipts: priorReceipts })
    !== canonicalJson({ children, evaluations: state.evaluations, child_receipts: childReceipts });
}

function completeContinuationLeaseProjectionUnlocked(state, transferEvent) {
  assert(transferEvent?.type === 'continuation_lease_transferred', 'CONTINUATION_TRANSFER_MISSING');
  const payload = transferEvent.payload || {};
  const predecessor = readJson(join(root(), 'capabilities', `${payload.predecessor_parent_ref}.json`), null);
  const successor = readJson(join(root(), 'capabilities', `${payload.successor_parent_ref}.json`), null);
  assert(predecessor?.kind === 'parent' && successor?.kind === 'parent', 'CONTINUATION_OWNER_MISSING');
  const activeAgentHashes = Object.entries(state.children || {})
    .filter(([, child]) => child.status !== 'STOP_OBSERVED' || !child.receipt_id)
    .map(([agentHash]) => agentHash)
    .sort();
  const childRecords = (payload.active_child_refs || []).map((capabilityHash) => {
    const path = join(root(), 'capabilities', `${capabilityHash}.json`);
    const record = readJson(path, null);
    assert(record?.kind === 'child' && record.parent_run_id === state.id, 'ACTIVE_CHILD_ROUTE_INCOMPLETE');
    return { path, record };
  });
  assert(canonicalJson(childRecords.map((item) => item.record.agent_hash).sort()) === canonicalJson(activeAgentHashes), 'ACTIVE_CHILD_ROUTE_INCOMPLETE');
  state.parent_capability_hash = payload.successor_parent_ref;
  state.continuation_lease = {
    capsule_ref: payload.capsule_ref,
    predecessor_parent_ref: payload.predecessor_parent_ref,
    successor_parent_ref: payload.successor_parent_ref
  };
  atomicWriteJson(join(root(), 'capabilities', `${payload.predecessor_parent_ref}.json`), {
    ...predecessor,
    revoked: {
      reason: 'continuation_lease_transferred',
      event_ref: `sha256:${transferEvent.event_hash}`,
      successor_parent_ref: payload.successor_parent_ref
    }
  });
  for (const child of childRecords) {
    atomicWriteJson(child.path, { ...child.record, parent_capability_hash: payload.successor_parent_ref });
    atomicWriteJson(migratedChildRoutePath(predecessor.session_hash, child.record.agent_hash), {
      run_id: state.id,
      agent_hash: child.record.agent_hash,
      successor_parent_ref: payload.successor_parent_ref
    });
  }
  saveState(state);
  atomicWriteJson(activePathByCapabilityHash(payload.successor_parent_ref), { run_id: state.id });
  rmSync(activePathByCapabilityHash(payload.predecessor_parent_ref), { force: true });
  const index = readJson(sessionRunsPath(successor.session_hash), { run_ids: [] });
  atomicWriteJson(sessionRunsPath(successor.session_hash), { run_ids: [...new Set([...(index.run_ids || []), state.id])] });
}

export function readLedger(runId, { allowOpen = true, recoverOpen = true } = {}) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assert(allowOpen || state.sealed, 'RUN_NOT_SEALED');
    const { events, tip } = parseLedger(runId);
    if (!state.sealed && recoverOpen && events.length > state.ledger_count) {
      const prefixTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1]?.event_hash;
      assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
      state.ledger_count = events.length;
      state.ledger_tip = tip;
      saveState(state);
    }
    assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
    if (state.sealed) {
      verifyChildReceipts(state);
      const anchor = readJson(anchorPath(runId), null);
      assert(
        anchor
        && anchor.run_id === runId
        && anchor.final_seq === events.length
        && anchor.final_hash === tip
        && anchor.state_hash === sha256(canonicalJson(state)),
        'LOCAL_CHAIN_BROKEN'
      );
    }
    return events;
  });
}

// The DURABLE seal signal is the run_sealed EVENT in the ledger, not the state.sealed flag: a crash
// after run_sealed is appended but before state and the seal anchor are written leaves the ledger
// sealed while state.sealed is still false. Adopt that terminal event into state (so repairSeal's
// consistency holds and any reader routes to the sealed path), failing closed if anything follows the
// first run_sealed — that would be post-seal corruption to surface, not fold into the receipt. Shared
// by checkpointOrSeal and verifyRun so a sealed ledger is never misclassified as open. Returns the
// parsed ledger so the caller can reuse it.
function adoptTerminalLedgerSeal(runId, state) {
  const parsed = parseLedger(runId);
  if (!state.sealed) {
    const sealedIndex = parsed.events.findIndex((event) => event.type === 'run_sealed');
    if (sealedIndex !== -1) {
      assert(sealedIndex === parsed.events.length - 1, 'LOCAL_CHAIN_BROKEN');
      stripLegacyChildReceiptPaths(state);
      state.sealed = true;
      state.terminal_status = parsed.events[sealedIndex].payload?.status || 'SEALED';
      state.ledger_count = parsed.events.length;
      state.ledger_tip = parsed.tip;
      saveState(state);
    }
  }
  return parsed;
}

function repairSeal(runId) {
  const state = loadState(runId);
  assert(state.sealed, 'RUN_NOT_SEALED');
  const { events, tip } = parseLedger(runId);
  assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  // A sealed run's FIRST run_sealed must be its terminal event: exactly one seal, at the end. Anything
  // after it — including a second run_sealed with a post-seal event between — is corruption to fail on,
  // not fold into the receipt (checking only the last event would miss an earlier seal + later write).
  assert(events.findIndex((event) => event.type === 'run_sealed') === events.length - 1, 'LOCAL_CHAIN_BROKEN');
  verifyChildReceipts(state);
  const stateHash = sha256(canonicalJson(state));
  const jsonPath = join(runDir(runId), 'receipt.json');
  const markdownPath = join(runDir(runId), 'RECEIPT.md');
  const anchor = readJson(anchorPath(runId), null);

  // The renderer gate reads the hash-chained run_sealed event, never the mutable anchor:
  // deleting or editing the anchor's informational receipt_renderer field must not be able
  // to select the weaker legacy path for a run the current renderer sealed.
  const sealedRenderer = events.find((event) => event.type === 'run_sealed')?.payload?.receipt_renderer ?? null;

  if (anchor) {
    // Ledger and state hash checks always apply — tamper evidence, renderer-independent.
    assert(
      anchor.run_id === runId
      && anchor.final_seq === events.length
      && anchor.final_hash === tip
      && anchor.state_hash === stateHash,
      'LOCAL_CHAIN_BROKEN'
    );
    if (sealedRenderer === ADAPTER_VERSION) {
      // Current renderer: the on-disk receipt must reproduce exactly what we render now.
      const receiptJson = renderReceiptJson(state, events);
      const receiptMarkdown = renderReceiptMarkdown(state, events);
      assert(anchor.receipt_json_hash === sha256(receiptJson), 'LOCAL_CHAIN_BROKEN');
      assert(anchor.receipt_markdown_hash === sha256(receiptMarkdown), 'LOCAL_CHAIN_BROKEN');
      if (existsSync(jsonPath)) assert(sha256(readFileSync(jsonPath, 'utf8')) === anchor.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      else atomicWriteText(jsonPath, receiptJson);
      if (existsSync(markdownPath)) assert(sha256(readFileSync(markdownPath, 'utf8')) === anchor.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
      else atomicWriteText(markdownPath, receiptMarkdown);
    } else {
      // Backward read-compat: the ledger's run_sealed event names no current-version renderer,
      // so this run was sealed by another renderer whose bytes we cannot reproduce. We do NOT
      // re-render or rewrite the receipt files; we verify the on-disk files still hash to the
      // anchor (tamper evidence preserved) and trust the anchor the seal committed to.
      assert(existsSync(jsonPath) && sha256(readFileSync(jsonPath, 'utf8')) === anchor.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(existsSync(markdownPath) && sha256(readFileSync(markdownPath, 'utf8')) === anchor.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
    }
    dropCheckpointAnchor(runId);
    // A sealed packet is not whole without its handoff tail. A crash after run_sealed became
    // durable but before continuation.json / HANDOFF.md / the index landed was previously
    // unrepairable from here — checkpointOrSeal excludes sealed runs, so this was the only path
    // that ever revisits the packet, and it stopped at the receipts.
    ensureStopArtifacts(runId, state);
    return { status: 'ALREADY_SEALED', run_id: runId, receipt_path: markdownPath };
  }

  // No anchor on disk (interrupted seal): re-render with the current renderer and write the anchor.
  const receiptJson = renderReceiptJson(state, events);
  const receiptMarkdown = renderReceiptMarkdown(state, events);
  const expected = {
    run_id: runId,
    final_seq: events.length,
    final_hash: tip,
    state_hash: stateHash,
    receipt_json_hash: sha256(receiptJson),
    receipt_markdown_hash: sha256(receiptMarkdown),
    receipt_renderer: ADAPTER_VERSION
  };
  // CZ-14: pre-seal Stops leave checkpoint receipt files on disk, so an interrupted seal (crash
  // after the sealed state was saved, before the sealed receipt files were written) presents here
  // with receipt bytes that mismatch the sealed render. Those bytes are recognized by the
  // hash-chained checkpoint_anchor event that committed them and overwritten with the sealed
  // render — an interrupted seal recovers; it is not tamper. Any committed checkpoint anchor's slot
  // is accepted, not only the last: if that final checkpoint write was itself torn, the on-disk
  // bytes legitimately match an EARLIER anchor (the same newest-first tolerance verifyOpenPacket
  // applies). Bytes matching neither the sealed render nor any ledger-committed checkpoint fail closed.
  const checkpointJsonHashes = new Set();
  const checkpointMarkdownHashes = new Set();
  for (const event of events) {
    if (event.type !== 'checkpoint_anchor') continue;
    checkpointJsonHashes.add(event.payload?.receipt_json_hash);
    checkpointMarkdownHashes.add(event.payload?.receipt_markdown_hash);
  }
  const staleCheckpointFile = (path, sealedHash, committedHashes) => {
    if (!existsSync(path)) return true;
    const hash = sha256(readFileSync(path, 'utf8'));
    if (hash === sealedHash) return false;
    assert(committedHashes.has(hash), 'LOCAL_CHAIN_BROKEN');
    return true;
  };
  if (staleCheckpointFile(jsonPath, expected.receipt_json_hash, checkpointJsonHashes)) atomicWriteText(jsonPath, receiptJson);
  if (staleCheckpointFile(markdownPath, expected.receipt_markdown_hash, checkpointMarkdownHashes)) atomicWriteText(markdownPath, receiptMarkdown);
  atomicWriteJson(anchorPath(runId), expected);
  dropCheckpointAnchor(runId);
  // Same tail repair as the anchored branch: an interrupted seal that lost its handoff artifacts
  // recovers them here or nowhere.
  ensureStopArtifacts(runId, state);
  return { status: 'ALREADY_SEALED', run_id: runId, receipt_path: markdownPath };
}

// A sealed packet carries exactly one anchor — the seal anchor. Cleanup of a leftover checkpoint
// anchor is best-effort: a copied packet may sit on read-only media, and cleanup must never turn
// verification into a raw filesystem error; a tolerated leftover is ignored by the sealed path.
function dropCheckpointAnchor(runId) {
  try {
    rmSync(checkpointAnchorPath(runId), { force: true });
  } catch {
    /* tolerated */
  }
}

function assertReferenceShape(value, optional = false) {
  if (optional && (value === null || value === undefined)) return;
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_EVENT_PAYLOAD');
  const keys = Object.keys(value);
  assert(keys.length === 2 && keys.includes('sha256') && keys.includes('bytes'), 'INVALID_EVENT_PAYLOAD');
  assert(/^[a-f0-9]{64}$/.test(String(value.sha256 || '')), 'INVALID_EVENT_PAYLOAD');
  assert(Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'INVALID_EVENT_PAYLOAD');
}

// Structural validation is an invariant, not a privacy projection. It therefore runs before every
// append in both verified_context and proof. Ineligible origins may still be witnessed as history,
// but the envelope itself must be bound to the active frozen contract/profile and registered
// producer identity so arbitrary values cannot ride a trusted-looking shape into the ledger.
function validateEventPayloadStructure(state, type, origin, payload) {
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'INVALID_EVENT_PAYLOAD');
  const registeredFields = EVENT_PAYLOAD_FIELDS.get(type);
  assert(registeredFields, 'UNREGISTERED_EVENT_TYPE');
  const unknown = Object.keys(payload).find((key) => !registeredFields.includes(key));
  assert(!unknown, 'UNREGISTERED_EVENT_FIELD');

  if (type === 'evidence_observed') {
    assert(state.claim_contract && state.claim_profile, 'CLAIM_CONTRACT_REQUIRED');
    const requirement = state.claim_profile.requirements?.find((item) => item.requirement_id === payload.requirement_id);
    assert(requirement, 'INVALID_EVIDENCE_BINDING');
    const expectedIdentity = state.claim_profile.producers?.[requirement.producer_id]?.expected_identity;
    assert(payload.contract_id === state.claim_contract.contract_id, 'INVALID_EVIDENCE_BINDING');
    assert(payload.profile_requirements_hash === state.claim_contract.profile_requirements_hash, 'INVALID_EVIDENCE_BINDING');
    assert(payload.event_kind === requirement.event_kind, 'INVALID_EVIDENCE_BINDING');
    assert(payload.producer_id === requirement.producer_id, 'INVALID_EVIDENCE_BINDING');
    assert(payload.producer_identity === expectedIdentity, 'INVALID_EVIDENCE_BINDING');
    assert(state.claim_contract.named_producers.includes(requirement.producer_id), 'INVALID_EVIDENCE_BINDING');
    assert(origin === 'mock_or_test' || requirement.eligible_origins.includes(origin), 'INVALID_EVIDENCE_BINDING');
    assert(payload.source_cursor === null
      || (typeof payload.source_cursor === 'string' && payload.source_cursor.length > 0 && payload.source_cursor.length <= 512), 'INVALID_EVIDENCE_BINDING');
    assert(payload.observed_at === undefined
      || payload.observed_at === null
      || typeof payload.observed_at === 'string', 'INVALID_EVIDENCE_BINDING');
    assert(payload.subject_binding && typeof payload.subject_binding === 'object' && !Array.isArray(payload.subject_binding), 'INVALID_EVIDENCE_BINDING');
    const bindingKeys = Object.keys(payload.subject_binding);
    assert(bindingKeys.length === requirement.subject_fields.length, 'INVALID_EVIDENCE_BINDING');
    assert(bindingKeys.every((key) => requirement.subject_fields.includes(key)), 'INVALID_EVIDENCE_BINDING');
    assert(requirement.subject_fields.every((key) => (
      typeof payload.subject_binding[key] === 'string'
      && payload.subject_binding[key].length > 0
      && payload.subject_binding[key].length <= 512
    )), 'INVALID_EVIDENCE_BINDING');
  }

  if (type === 'producer_terminal') {
    assert(state.claim_contract && state.claim_profile, 'CLAIM_CONTRACT_REQUIRED');
    const producer = state.claim_profile.producers?.[payload.producer_id];
    assert(producer && state.claim_contract.named_producers.includes(payload.producer_id), 'INVALID_PRODUCER_TERMINAL');
    assert(payload.contract_id === state.claim_contract.contract_id, 'INVALID_PRODUCER_TERMINAL');
    assert(payload.claim_contract_ref === state.claim_contract.claim_contract_ref, 'INVALID_PRODUCER_TERMINAL');
    assert(payload.producer_identity === producer.expected_identity, 'INVALID_PRODUCER_TERMINAL');
    assert(origin === 'runtime_hook', 'INVALID_PRODUCER_TERMINAL');
    assert(PRODUCER_TERMINAL_STATUSES.has(payload.status), 'INVALID_PRODUCER_TERMINAL');
    assert(payload.source_cursor === undefined
      || (typeof payload.source_cursor === 'string' && payload.source_cursor.length > 0 && payload.source_cursor.length <= 512), 'INVALID_PRODUCER_TERMINAL');
    assert(payload.observed_at === undefined
      || payload.observed_at === null
      || typeof payload.observed_at === 'string', 'INVALID_PRODUCER_TERMINAL');
    assert(payload.evidence_refs === undefined
      || (Array.isArray(payload.evidence_refs)
        && payload.evidence_refs.every((ref) => /^sha256:[a-f0-9]{64}$/.test(String(ref)))), 'INVALID_PRODUCER_TERMINAL');
  }

  if (type === 'producer_requested') {
    const code = 'INVALID_PRODUCER_REQUEST';
    assert(origin === 'mcp_routed' && state.claim_contract && state.claim_profile, code);
    const producer = state.claim_profile.producers?.[payload.producer_id];
    assert(producer && state.claim_contract.named_producers.includes(payload.producer_id), code);
    assert(payload.contract_id === state.claim_contract.contract_id, code);
    assert(payload.claim_contract_ref === state.claim_contract.claim_contract_ref, code);
    assert(payload.expected_identity === producer.expected_identity, code);
  }

  if (type === 'closeout_attempted') {
    validateCloseoutAttemptBinding(state, origin, payload);
  }

  if (type === 'diagnostic_emitted' || type === 'diagnostic_resolved') {
    const code = 'INVALID_CLAIM_DIAGNOSTIC';
    assert(origin === 'runtime_hook', code);
    assertCurrentCompiledBinding(state, payload, code);
    assert(typeof payload.diagnostic_id === 'string' && payload.diagnostic_id.length > 0, code);
    assert(typeof payload.blocker_fingerprint === 'string' && payload.blocker_fingerprint.length > 0, code);
    assert(payload.diagnostic_status === (type === 'diagnostic_emitted' ? 'OPEN' : 'RESOLVED'), code);
    if (type === 'diagnostic_emitted') {
      const gateId = state.claim_contract.declared_gate_ids[0];
      assert(payload.blocker_fingerprint === claimCloseoutBlockerFingerprint(state, gateId, state.compiled_claim), code);
      assert(payload.supported_state === state.compiled_claim.highest_supported_state, code);
      assert(payload.requested_state === state.claim_contract.requested_state, code);
      assert(canonicalJson(payload.missing) === canonicalJson(state.compiled_claim.missing), code);
      assert(payload.next_verifier === state.compiled_claim.next_verifier, code);
    }
  }

  if (type === 'closeout_envelope_generated') {
    validateCloseoutEnvelopeBinding(state, origin, payload);
  }

  if (type === 'pr_snapshot') {
    const countKeys = ['files', 'checks', 'reviews', 'review_comments', 'issue_comments'];
    const counts = payload.counts || {};
    assert(counts && typeof counts === 'object' && !Array.isArray(counts), 'INVALID_EVENT_PAYLOAD');
    assert(!Object.keys(counts).find((key) => !countKeys.includes(key)), 'INVALID_EVENT_PAYLOAD');
    assert(Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0), 'INVALID_EVENT_PAYLOAD');
    assert(Array.isArray(payload.failures || []), 'INVALID_EVENT_PAYLOAD');
    for (const failure of payload.failures || []) {
      assert(failure && typeof failure === 'object' && !Array.isArray(failure), 'INVALID_EVENT_PAYLOAD');
      assert(!Object.keys(failure).find((key) => !['object', 'error'].includes(key)), 'INVALID_EVENT_PAYLOAD');
      assert(typeof failure.object === 'string' && typeof failure.error === 'string', 'INVALID_EVENT_PAYLOAD');
    }
  }

  if (type.startsWith('hook_')) {
    assertReferenceShape(payload.payload_ref);
    assertReferenceShape(payload.cwd_ref, true);
  }
}

// Invalid observed time is itself material currentness evidence. Preserve that fact without
// preserving arbitrary timestamp-shaped input: null is the canonical malformed/missing marker the
// pure compiler already treats as CURRENTNESS_UNPROVEN.
function normalizeEventPayloadForStorage(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (type === 'pr_snapshot') {
    return {
      ...payload,
      head_before: proofSafeGitObjectId(payload.head_before),
      head_after: proofSafeGitObjectId(payload.head_after)
    };
  }
  if (type === 'pr_refreshed') {
    return { ...payload, observed_head: proofSafeGitObjectId(payload.observed_head) };
  }
  if (type === 'evaluation_requested') {
    return { ...payload, expected_head: proofSafeGitObjectId(payload.expected_head) };
  }
  if (type === 'evaluation_finding') {
    return {
      ...payload,
      expected_head: proofSafeGitObjectId(payload.expected_head),
      checkout_head_before: proofSafeGitObjectId(payload.checkout_head_before),
      checkout_head_after: proofSafeGitObjectId(payload.checkout_head_after)
    };
  }
  if (type === 'evidence_observed') {
    let normalized = payload;
    if (normalized.subject_binding
      && typeof normalized.subject_binding === 'object'
      && !Array.isArray(normalized.subject_binding)) {
      const subjectBinding = Object.fromEntries(Object.entries(normalized.subject_binding).map(([key, value]) => [
        key,
        typeof value === 'string' && !/^sha256:[a-f0-9]{64}$/.test(value)
          ? `sha256:${sha256(value)}`
          : value
      ]));
      normalized = { ...normalized, subject_binding: subjectBinding };
    }
    if (typeof normalized.source_cursor !== 'string'
      || normalized.source_cursor.length === 0
      || normalized.source_cursor.length > 512) {
      normalized = { ...normalized, source_cursor: null };
    } else if (!/^cursor_[a-f0-9]{64}$/.test(normalized.source_cursor)) {
      normalized = { ...normalized, source_cursor: `cursor_${sha256(normalized.source_cursor)}` };
    }
    if (!isCanonicalObservedAt(normalized.observed_at)) {
      normalized = { ...normalized, observed_at: null };
    }
    return normalized;
  }
  if (type === 'producer_terminal') {
    let normalized = payload;
    if (typeof normalized.source_cursor === 'string'
      && normalized.source_cursor.length > 0
      && normalized.source_cursor.length <= 512
      && !/^cursor_[a-f0-9]{64}$/.test(normalized.source_cursor)) {
      normalized = { ...normalized, source_cursor: `cursor_${sha256(normalized.source_cursor)}` };
    }
    if (normalized.observed_at !== undefined && !isCanonicalObservedAt(normalized.observed_at)) {
      normalized = { ...normalized, observed_at: null };
    }
    return normalized;
  }
  return payload;
}

// Fold-v2 proof mode is an at-write guarantee. These projections happen after structural validation
// but before canonical hashing, so neither the ledger nor any downstream artifact can recover
// withheld prose. Legacy ledgers are never rewritten; this function is reached only for new appends.
function projectEventPayloadForPrivacy(state, type, payload) {
  if (state.privacy_mode !== 'proof') return payload;
  if (type.startsWith('hook_')) {
    const { payload_ref: _payloadRef, ...structural } = payload;
    return { ...structural, text_withheld: true };
  }
  if (type === 'builder_claim') {
    return {
      builder_claim_id: payload.builder_claim_id,
      builder_claim_ordinal: payload.builder_claim_ordinal,
      evidence_refs: payload.evidence_refs || [],
      text_withheld: true
    };
  }
  if (type === 'evaluation_finding') {
    const { statement: _statement, statement_text: _text, statement_ref: _ref, ...structural } = payload;
    return {
      ...structural,
      expected_head: proofSafeGitObjectId(structural.expected_head),
      checkout_head_before: proofSafeGitObjectId(structural.checkout_head_before),
      checkout_head_after: proofSafeGitObjectId(structural.checkout_head_after),
      text_withheld: true
    };
  }
  if (type === 'evaluation_requested') {
    return { ...payload, expected_head: proofSafeGitObjectId(payload.expected_head) };
  }
  if (type === 'close_requested') {
    return { request_id: payload.request_id, text_withheld: true };
  }
  if (type === 'claim_contract_declared') {
    const { profile_display: _display, contract_display: _contractDisplay, ...structural } = payload;
    return { ...structural, text_withheld: true };
  }
  if (type === 'diagnostic_emitted' || type === 'diagnostic_resolved') {
    const { message: _message, narrative: _narrative, ...structural } = payload;
    return { ...structural, text_withheld: true };
  }
  if (type === 'closeout_envelope_generated') {
    const { narrative: _narrative, ...structural } = payload;
    return { ...structural, text_withheld: true };
  }
  if (type === 'pr_snapshot') {
    return {
      ...payload,
      head_before: proofSafeGitObjectId(payload.head_before),
      head_after: proofSafeGitObjectId(payload.head_after),
      failures: (payload.failures || []).map((failure) => ({
        object: String(failure?.object || ''),
        text_withheld: true
      }))
    };
  }
  if (type === 'pr_refreshed') {
    return { ...payload, observed_head: proofSafeGitObjectId(payload.observed_head) };
  }
  if (type === 'evidence_observed') {
    const requirement = state.claim_profile?.requirements?.find((item) => item.requirement_id === payload.requirement_id);
    const opaqueBinding = Object.fromEntries(requirement.subject_fields.map((key) => {
      const value = payload.subject_binding[key];
      return [key, /^sha256:[a-f0-9]{64}$/.test(value) ? value : `sha256:${sha256(value)}`];
    }));
    const sourceCursor = payload.source_cursor === null
      ? null
      : /^cursor_[a-f0-9]{64}$/.test(payload.source_cursor)
        ? payload.source_cursor
        : `cursor_${sha256(payload.source_cursor)}`;
    return { ...payload, source_cursor: sourceCursor, subject_binding: opaqueBinding };
  }
  if (type === 'producer_terminal' && payload.source_cursor) {
    return {
      ...payload,
      source_cursor: /^cursor_[a-f0-9]{64}$/.test(payload.source_cursor)
        ? payload.source_cursor
        : `cursor_${sha256(payload.source_cursor)}`
    };
  }
  return payload;
}

function appendEventUnlocked(runId, state, { type, origin, payload, idempotencyKey }) {
  assert(ORIGINS.has(origin), 'INVALID_ORIGIN');
  assert(!state.sealed, 'RUN_SEALED');
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'INVALID_EVENT_PAYLOAD');
  const normalizedPayload = normalizeEventPayloadForStorage(type, payload);
  validateEventPayloadStructure(state, type, origin, normalizedPayload);
  const projectedPayload = projectEventPayloadForPrivacy(state, type, normalizedPayload);
  validateProofIdentityProvenance(state, type, projectedPayload);
  const { events, tip } = parseLedger(runId);
  const latestEnvelope = [...events].reverse().find((event) => event.type === 'closeout_envelope_generated');
  if (latestEnvelope && latestEnvelope.seq !== events.at(-1)?.seq) {
    assert(events.some((event) => event.type === 'run_sealed' && event.seq > latestEnvelope.seq), 'CLOSEOUT_ENVELOPE_TAIL');
  }
  if (events.at(-1)?.type === 'closeout_envelope_generated') {
    assert(type === 'run_sealed', 'CLOSEOUT_ENVELOPE_PENDING_SEAL');
  }
  if (events.length > state.ledger_count) {
    const prefixTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1]?.event_hash;
    assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
    state.ledger_count = events.length;
    state.ledger_tip = tip;
  }
  assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  if (state.privacy_mode === 'proof' && type.startsWith('hook_')) {
    assert(/^hook:[^:]+:id_[a-f0-9]{64}$/.test(String(idempotencyKey || '')), 'PROOF_HOOK_DELIVERY_ID_REQUIRED');
  }
  const rawKey = idempotencyKey || sha256(canonicalJson({ origin, payload: projectedPayload, type }));
  // Idempotency keys are part of the hash-chained event. In proof mode even a caller-supplied
  // structural key is projected to an opaque digest, so this side channel cannot retain objective,
  // diagnostic, or tool prose that the payload projection deliberately withheld.
  const key = state.privacy_mode === 'proof' ? `idempotency_${sha256(String(rawKey))}` : rawKey;
  const contentHash = sha256(canonicalJson({ origin, payload: projectedPayload, type }));
  const duplicate = events.find((event) => event.idempotency_key === key);
  if (duplicate) {
    assert(contentHash === duplicate.content_hash, 'IDEMPOTENCY_CONFLICT');
    return duplicate;
  }
  // No NEW event may follow a terminal run_sealed. The durable ledger seal is authoritative even when
  // the passed state.sealed flag lags it (crash after the seal append, before state was saved), so
  // EVERY mutable tool that reaches this shared append path — record_claim, snapshot_pr,
  // request_close, record_evaluation, read_sealed_receipt's retrieval mark, etc. — fails closed with
  // RUN_SEALED here rather than appending post-seal corruption. Idempotent re-appends returned above
  // are unaffected.
  assert(!events.some((event) => event.type === 'run_sealed'), 'RUN_SEALED');
  const event = {
    schema: 'lyhna.codex.event.v0',
    seq: events.length + 1,
    prev_hash: events.at(-1)?.event_hash || ZERO_HASH,
    idempotency_key: key,
    content_hash: contentHash,
    type,
    origin,
    payload: projectedPayload
  };
  event.event_hash = sha256(canonicalJson(event));
  mkdirSync(runDir(runId), { recursive: true });
  appendFileSync(ledgerPath(runId), `${canonicalJson(event)}\n`, { encoding: 'utf8', flush: true });
  state.ledger_count = event.seq;
  state.ledger_tip = event.event_hash;
  return event;
}

export function appendEvent(runId, input) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    recoverClaimControlStateUnlocked(runId, state);
    // Supervisor-owned proof families may carry retained structural identities next to withheld
    // prose. Their provenance is the capability-bound product path that derives those identities,
    // not a caller label or string shape. The generic adapter writer therefore cannot emit them.
    if (state.privacy_mode === 'proof') {
      const supervisorOwned = PROOF_SUPERVISOR_OWNED_EVENTS.has(input?.type)
        || String(input?.type || '').startsWith('hook_');
      if (supervisorOwned) {
        // Keep the closed-schema error boundary ahead of provenance so unknown fields are still
        // rejected as unknown fields; a structurally valid impersonation reaches this hard stop.
        const normalized = normalizeEventPayloadForStorage(input.type, input.payload);
        validateEventPayloadStructure(state, input.type, input.origin, normalized);
        const projected = projectEventPayloadForPrivacy(state, input.type, normalized);
        validateProofIdentityProvenance(state, input.type, projected);
        assert(false, 'PROOF_EVENT_PROVENANCE_REQUIRED');
      }
    }
    // This exported writer exists for deterministic adapters/tests. In proof mode its caller key is
    // untrusted text, so derive idempotency only from the already-projected event structure. Internal
    // product paths call appendEventUnlocked with supervisor-issued structural keys.
    const safeInput = state.privacy_mode === 'proof' ? { ...input, idempotencyKey: null } : input;
    const event = appendEventUnlocked(runId, state, safeInput);
    saveState(state);
    return event;
  });
}

function requireParent(capability, { mutable = true } = {}) {
  const record = getCapability(capability);
  assert(record.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  const runId = activeRunFor(capability, { includeSealed: !mutable });
  assert(runId, 'NO_ACTIVE_RUN');
  const state = withLock(lockPath(runId), () => {
    const current = loadState(runId);
    recoverClaimControlStateUnlocked(runId, current);
    adoptTerminalLedgerSeal(runId, current);
    if (mutable && current.sealed) {
      repairSeal(runId);
      assert(false, 'RUN_SEALED');
    }
    return current;
  });
  if (mutable) assert(!state.sealed, 'RUN_SEALED');
  assert(state.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
  return { record, runId, state };
}

function assertParentLeaseUnlocked(runId, state, capability) {
  recoverClaimControlStateUnlocked(runId, state);
  const record = getCapability(capability);
  assert(record.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  assert(!record.revoked, 'CAPABILITY_REVOKED');
  assert(!state.sealed && state.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
}

function requireChild(capability) {
  const record = getCapability(capability);
  assert(record.kind === 'child', 'CHILD_CAPABILITY_REQUIRED');
  const state = loadState(record.parent_run_id);
  assert(!state.sealed, 'RUN_SEALED');
  return { record, runId: record.parent_run_id, state };
}

function assertChildLeaseUnlocked(runId, state, capability) {
  recoverClaimControlStateUnlocked(runId, state);
  const record = getCapability(capability);
  assert(record.kind === 'child', 'CHILD_CAPABILITY_REQUIRED');
  assert(record.parent_run_id === runId, 'EVALUATOR_PARENT_MISMATCH');
  assert(record.parent_capability_hash === state.parent_capability_hash, 'EVALUATOR_PARENT_MISMATCH');
  assert(!state.sealed, 'RUN_SEALED');
  return record;
}

export const PRIVACY_MODES = new Set(['verified_context', 'proof']);

// Fixed at run start and sealed into run_begun, NEVER read from the environment at render time.
// Rendering must stay a pure function of the packet: if the same ledger could render differently
// depending on an env var, re-verification would fail and determinism would be gone.
function resolvePrivacyMode(requested) {
  const candidate = String(requested || process.env.LYHNA_PRIVACY_MODE || 'verified_context').trim();
  assert(PRIVACY_MODES.has(candidate), 'INVALID_PRIVACY_MODE');
  return candidate;
}

export function beginRun(capability, { mode, objective = '', continuesFrom = '', privacyMode = '' }) {
  const parent = getCapability(capability);
  assert(parent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  assert(mode === 'full' || mode === 'pr_only', 'INVALID_MODE');
  const privacy = resolvePrivacyMode(privacyMode);
  const continuationRef = String(continuesFrom || '').trim();
  const canonicalContinuationRef = /^[a-f0-9]{64}$/.test(continuationRef) ? continuationRef : '';
  if (privacy === 'proof' && continuationRef) assert(canonicalContinuationRef, 'INVALID_CAPSULE_REF');
  // verified_context preserves the historical unresolved-edge behavior without storing arbitrary
  // caller prose as an identity. Proof mode remains fail-closed because even an unresolved marker
  // must not accept prompt-shaped input at its portable boundary.
  const projectedUnresolvedContinuation = continuationRef && !canonicalContinuationRef
    ? { capsule_ref: null, run_id: null, state_hash: null, resolution: 'UNRESOLVED_LOCALLY' }
    : null;
  continuesFrom = canonicalContinuationRef;
  return withLock(sessionLockPath(capability), () => withLock(continuationLockPath(), () => {
    const currentParent = getCapability(capability);
    assert(currentParent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
    assert(!currentParent.revoked, 'CAPABILITY_REVOKED');
    const pendingPath = join(root(), 'pending', `${parent.session_hash}.json`);
    const pending = readJson(pendingPath, null);
    const current = activeRunFor(capability, { includeSealed: true }) || locateOpenClaimRunForParent(capability);
    if (current) {
      const state = withLock(lockPath(current), () => {
        const recovered = loadState(current);
        const parsed = recoverClaimControlStateUnlocked(current, recovered);
        adoptTerminalLedgerSeal(current, recovered);
        const callerHash = sha256(capability);
        const transfer = [...parsed.events].reverse().find((event) => (
          event.type === 'continuation_lease_transferred'
          && event.payload?.successor_parent_ref === callerHash
          && (!continuesFrom || event.payload?.capsule_ref === continuesFrom)
        ));
        if (transfer && continuesFrom) completeContinuationLeaseProjectionUnlocked(recovered, transfer);
        return recovered;
      });
      const callerHash = sha256(capability);
      if (state.parent_capability_hash !== callerHash) {
        const transfer = [...parseLedger(current).events].reverse().find((event) => (
          event.type === 'continuation_lease_transferred'
          && event.payload?.predecessor_parent_ref === callerHash
        ));
        assert(!transfer, 'CAPABILITY_REVOKED');
        assert(false, 'CAPABILITY_RUN_MISMATCH');
      }
      // A durable terminal run_sealed whose state.sealed lagged (crash after the seal append, before
      // state/anchor) must be adopted here too — begin_run is a likely recovery path. Otherwise
      // reattach hands back a run every mutable tool now rejects with RUN_SEALED, wedging the session;
      // adopt under the run lock like the Stop/verify paths, then fall through to finalize and start fresh.
      if (!state.sealed) {
        atomicWriteJson(activePath(capability), { run_id: current });
        if (pending) rmSync(pendingPath, { force: true });
        return state;
      }
      if (!existsSync(anchorPath(current))) repairSeal(current);
    }
    if (!current && continuesFrom) {
      const transferred = (() => {
        let resolved = resolveContinuesFrom(continuesFrom);
        assert(resolved?.resolution !== 'LOCAL_PREDECESSOR_UNAVAILABLE', 'CONTINUATION_PREDECESSOR_UNAVAILABLE');
        if (resolved?.resolution === 'RESOLVED_LOCAL_ARCHIVE' && resolved.run_id) {
          const restoredCurrentFace = withLock(lockPath(resolved.run_id), () => {
            const prior = loadState(resolved.run_id);
            recoverClaimControlStateUnlocked(resolved.run_id, prior);
            if (prior.sealed || !prior.claim_contract) return false;
            ensureStopArtifacts(resolved.run_id, prior);
            return true;
          });
          if (!restoredCurrentFace) return null;
          resolved = resolveContinuesFrom(continuesFrom);
          assert(resolved?.resolution === 'RESOLVED_LOCAL_PACKET', 'STALE_CONTINUATION');
        }
        if (resolved?.resolution !== 'RESOLVED_LOCAL_PACKET' || !resolved.run_id) return null;
        return withLock(lockPath(resolved.run_id), () => {
          const prior = loadState(resolved.run_id);
          if (prior.sealed) return null;
          // Same-ledger ownership transfer is a v2 claim-contract feature. Legacy and
          // contract-free continuations retain the historical successor-run edge.
          const parsed = recoverClaimControlStateUnlocked(resolved.run_id, prior);
          if (!prior.claim_contract) return null;
          const newParentHash = sha256(capability);
          const priorTransfer = [...parsed.events].reverse().find((event) => (
            event.type === 'continuation_lease_transferred' && event.payload?.capsule_ref === continuesFrom
          ));
          if (priorTransfer) {
            assert(priorTransfer.payload.successor_parent_ref === newParentHash, 'CONTINUATION_ALREADY_TRANSFERRED');
            completeContinuationLeaseProjectionUnlocked(prior, priorTransfer);
            return prior;
          }
          const packetVerification = verifyOpenPacket(resolved.run_id);
          assert(packetVerification.status === 'CHECKPOINT_VERIFIED', 'CONTINUATION_PACKET_UNVERIFIED');
          assert(prior.mode === mode, 'CONTINUATION_MODE_MISMATCH');
          assert(prior.privacy_mode === privacy, 'CONTINUATION_PRIVACY_MISMATCH');
          const published = readJson(join(runDir(resolved.run_id), 'continuation.json'), null);
          if (!published?.claim_compiler) return null;
          assert(published?.capsule_ref === continuesFrom && deriveCapsuleRef(published) === continuesFrom, 'STALE_CONTINUATION');
          const { events, tip } = parseLedger(resolved.run_id);
          assert(events.length === prior.ledger_count && tip === prior.ledger_tip, 'STALE_CONTINUATION');
          const reconstructed = buildContinuation(prior, events, CURRENT_FOLD_VERSION);
          assert(reconstructed.capsule_ref === published.capsule_ref && reconstructed.state_hash === published.state_hash, 'STALE_CONTINUATION');
          assert(canonicalJson(reconstructed.claim_compiler ?? null) === canonicalJson(published.claim_compiler ?? null), 'CONTINUATION_CONTROL_MISMATCH');

          const oldParentHash = prior.parent_capability_hash;
          assert(oldParentHash !== newParentHash, 'CONTINUATION_ALREADY_OWNED');
          const oldParentRecord = readJson(join(root(), 'capabilities', `${oldParentHash}.json`), null);
          assert(oldParentRecord?.kind === 'parent', 'CONTINUATION_OWNER_MISSING');
          const capabilityFiles = readdirSync(join(root(), 'capabilities'), { withFileTypes: true });
          const activeAgentHashes = Object.entries(prior.children || {})
            .filter(([, child]) => child.status !== 'STOP_OBSERVED' || !child.receipt_id)
            .map(([agentHash]) => agentHash)
            .sort();
          const childRecords = [];
          for (const entry of capabilityFiles) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const path = join(root(), 'capabilities', entry.name);
            const record = readJson(path, null);
            if (record?.kind === 'child' && record.parent_run_id === prior.id && activeAgentHashes.includes(record.agent_hash)) {
              childRecords.push({ path, record });
            }
          }
          assert(new Set(childRecords.map((item) => item.record.agent_hash)).size === activeAgentHashes.length, 'ACTIVE_CHILD_ROUTE_INCOMPLETE');

          appendEventUnlocked(prior.id, prior, {
            type: 'continuation_lease_transferred',
            origin: 'runtime_hook',
            payload: {
              capsule_ref: continuesFrom,
              predecessor_parent_ref: oldParentHash,
              successor_parent_ref: newParentHash,
              active_child_refs: childRecords.map((item) => item.record.capability_hash).sort()
            },
            idempotencyKey: `continuation-transfer:${continuesFrom}:${newParentHash}`
          });
          const transferEvent = parseLedger(resolved.run_id).events.at(-1);
          completeContinuationLeaseProjectionUnlocked(prior, transferEvent);
          return prior;
        });
      })();
      if (transferred) {
        const transferredIndex = readJson(sessionRunsPath(parent.session_hash), { run_ids: [] });
        const runIds = [...new Set([...(transferredIndex.run_ids || []), transferred.id])];
        atomicWriteJson(sessionRunsPath(parent.session_hash), { run_ids: runIds });
        if (pending) rmSync(pendingPath, { force: true });
        return transferred;
      }
    }
    // CZ-12: observe (never judge) any prior run in this session left OPEN with no close request.
    const sessionIndex = readJson(sessionRunsPath(parent.session_hash), { run_ids: [] });
    const openPredecessors = [];
    for (const priorId of sessionIndex.run_ids || []) {
      const priorState = readJson(statePath(priorId), null);
      if (priorState && !priorState.sealed && !priorState.close_requested) {
        openPredecessors.push({ run_id: priorId, last_event_seq: priorState.ledger_count });
      }
    }
    openPredecessors.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
    const runId = `run_${randomUUID()}`;
    const state = {
      schema: 'lyhna.codex.run.v0',
      id: runId,
      mode,
      privacy_mode: privacy,
      sealed: false,
      parent_capability_hash: sha256(capability),
      objective: privacy === 'proof' ? 'Objective withheld.' : pending?.summary || promptSynopsis(objective),
      // Retained alongside the structural summary, exactly as claim text is: the owner's own request,
      // on the owner's own machine. Proof mode projects it away for a packet that leaves.
      objective_text: privacy === 'proof' ? '' : pending?.text || objectiveText(objective),
      // Supervisor-issued and prose-independent. Callers may reuse this exact opaque reference in a
      // claim contract, but cannot mint a prompt-derived digest that proof mode would preserve.
      objective_ref: `objective_${sha256(canonicalJson({ kind: 'run_objective', run_id: runId }))}`,
      claim_contract_id: `contract_${sha256(canonicalJson({ kind: 'claim_contract', run_id: runId })).slice(0, 32)}`,
      objective_text_withheld: privacy === 'proof',
      objective_origin: pending ? 'runtime_hook' : 'agent_reported',
      configured_hooks: CONFIGURED_HOOKS,
      ledger_count: 0,
      ledger_tip: ZERO_HASH,
      close_requested: null,
      open_predecessors: openPredecessors,
      // The lineage edge to the window this run continues. Resolved locally, never taken on the
      // agent's word; null when no predecessor was declared.
      inherits: projectedUnresolvedContinuation || resolveContinuesFrom(continuesFrom),
      claim_contract: null,
      claim_profile: null,
      compiled_claim: null,
      claim_diagnostic: null,
      closeout_envelope: null,
      terminal_status: null,
      continuation_lease: null,
      pr_snapshots: {},
      evaluations: {},
      children: {},
      child_receipts: {}
    };
    mkdirSync(runDir(runId), { recursive: true });
    const runBegunPayload = {
      mode,
      privacy_mode: privacy,
      objective_origin: state.objective_origin,
      objective_ref: state.objective_ref,
      claim_contract_id: state.claim_contract_id,
      ...(privacy === 'proof' ? { text_withheld: true } : {})
    };
    if (pending) runBegunPayload.invocation = { matched_form: pending.matched_form, mention_offset: pending.mention_offset };
    if (openPredecessors.length) runBegunPayload.open_predecessors = openPredecessors;
    // Sealed into run_begun, therefore inside the hash chain, therefore covered by the seal anchor:
    // the inheritance claim cannot be added or altered after the fact without breaking the chain.
    if (state.inherits) runBegunPayload.inherits = state.inherits;
    withLock(lockPath(runId), () => {
      appendEventUnlocked(runId, state, {
        type: 'run_begun',
        origin: 'mcp_routed',
        payload: runBegunPayload,
        idempotencyKey: `begin:${runId}`
      });
      saveState(state);
    });
    atomicWriteJson(activePath(capability), { run_id: runId });
    const nextRunIds = [...(sessionIndex.run_ids || [])];
    if (!nextRunIds.includes(runId)) nextRunIds.push(runId);
    atomicWriteJson(sessionRunsPath(parent.session_hash), { run_ids: nextRunIds });
    if (pending) rmSync(pendingPath, { force: true });
    return state;
  }));
}

const INVOCATION_NON_BOUNDARY_BEFORE = /[\p{L}\p{M}\p{N}_@]/u;
const INVOCATION_STRUCTURED = /^\[@?lyhna[^\]]*\]\(plugin:\/\/lyhna-codex-adapter(?=[^\p{L}\p{M}\p{N}_-])[^)]*\)/iu;
const INVOCATION_URI = /plugin:\/\/lyhna-codex-adapter(?=$|[^\p{L}\p{M}\p{N}_-])/giu;
const INVOCATION_LITERAL_LONG = /^@lyhna-codex-adapter(?:@[a-z0-9-]+)?(?=$|[^\p{L}\p{M}\p{N}_-])/iu;
const INVOCATION_LITERAL_SHORT = /^@lyhna(?=$|[^\p{L}\p{M}\p{N}_-])/iu;
const INVOCATION_LITERAL_DOLLAR = /^\$lyhna(?=$|[^\p{L}\p{M}\p{N}_-])/iu;

function detectInvocation(promptText) {
  for (let index = 0; index < promptText.length; index += 1) {
    const rest = promptText.slice(index);
    if (INVOCATION_STRUCTURED.test(rest)) return { matched_form: 'structured', mention_offset: index };
    if (index !== 0 && INVOCATION_NON_BOUNDARY_BEFORE.test(promptText[index - 1])) continue;
    if (INVOCATION_LITERAL_LONG.test(rest)) return { matched_form: 'literal_long', mention_offset: index };
    if (INVOCATION_LITERAL_SHORT.test(rest)) return { matched_form: 'literal_short', mention_offset: index };
    if (INVOCATION_LITERAL_DOLLAR.test(rest)) return { matched_form: 'literal_dollar', mention_offset: index };
  }
  for (const uriMatch of promptText.matchAll(INVOCATION_URI)) {
    if (uriMatch.index === 0 || !INVOCATION_NON_BOUNDARY_BEFORE.test(promptText[uriMatch.index - 1])) {
      return { matched_form: 'structured', mention_offset: uriMatch.index };
    }
  }
  return null;
}

function maskContextCharacter(ch) {
  if (/\s/.test(ch)) return ' ';
  if (/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(ch)) return ch;
  if (/\p{Nd}/u.test(ch)) return '9';
  if (/\p{Lu}/u.test(ch)) return 'A';
  if (/[\p{L}\p{M}\p{N}]/u.test(ch)) return 'a';
  return '?';
}

function maskedMentionContexts(promptText) {
  const contexts = [];
  const pattern = /lyhna/gi;
  let match;
  while ((match = pattern.exec(promptText)) && contexts.length < 8) {
    const start = Math.max(0, match.index - 16);
    const end = Math.min(promptText.length, match.index + match[0].length + 16);
    contexts.push(Array.from(promptText.slice(start, end), maskContextCharacter).join(''));
  }
  return contexts;
}

function coercePromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((part) => {
      if (typeof part === 'string') return part;
      return part === null || part === undefined ? '' : canonicalJson(part);
    }).join('\n');
  }
  if (prompt && typeof prompt === 'object') return canonicalJson(prompt);
  return '';
}

const INVOCATION_MISS_LIMIT = 32;

function recordInvocationMiss(promptText) {
  if (!/lyhna/i.test(promptText)) return;
  const missDir = join(root(), 'pending-miss');
  let existing = [];
  try { existing = readdirSync(missDir); } catch { existing = []; }
  const digest = sha256(promptText);
  if (existing.length >= INVOCATION_MISS_LIMIT && !existing.includes(`miss-${digest.slice(0, 16)}.json`)) return;
  const lower = promptText.toLowerCase();
  atomicWriteJson(join(missDir, `miss-${digest.slice(0, 16)}.json`), {
    ref: digest,
    prompt_bytes: Buffer.byteLength(promptText),
    contains_at_sigil: lower.includes('@lyhna'),
    contains_dollar_sigil: lower.includes('$lyhna'),
    contains_plugin_uri: lower.includes('plugin://lyhna-codex-adapter'),
    mention_contexts: maskedMentionContexts(promptText)
  });
}

export function rememberInvocation({ sessionId, prompt }) {
  const promptText = coercePromptText(prompt);
  const detected = detectInvocation(promptText);
  if (!detected) {
    recordInvocationMiss(promptText);
    return false;
  }
  if (!sessionId) return false;
  const sessionHash = sha256(String(sessionId));
  atomicWriteJson(join(root(), 'pending', `${sessionHash}.json`), {
    summary: promptSynopsis(promptText),
    text: objectiveText(promptText),
    ref: sha256(promptText),
    matched_form: detected.matched_form,
    mention_offset: detected.mention_offset,
    prompt_bytes: Buffer.byteLength(promptText)
  });
  return true;
}

export function recordClaim(capability, statement, evidenceRefs = []) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    const { events } = parseLedger(runId);
    const ordinal = events.filter((event) => event.type === 'builder_claim').length + 1;
    const builderClaimId = `claim_${sha256(canonicalJson({ run_id: runId, event_type: 'builder_claim', ordinal })).slice(0, 24)}`;
    const payload = {
      ...sanitizeClaim(statement, evidenceRefs),
      builder_claim_id: builderClaimId,
      builder_claim_ordinal: ordinal
    };
    const event = appendEventUnlocked(runId, state, {
      type: 'builder_claim',
      origin: 'agent_reported',
      payload,
      idempotencyKey: `builder-claim:${builderClaimId}`
    });
    saveState(state);
    return event;
  });
}

export function recordHookForParent(capability, payload, idempotencyKey) {
  const active = activeRunFor(capability);
  if (!active) return null;
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    const event = appendEventUnlocked(runId, state, {
      type: `hook_${String(payload.event || 'unknown').toLowerCase()}`,
      origin: 'runtime_hook',
      payload,
      idempotencyKey
    });
    saveState(state);
    return event;
  });
}

// Occurrence numbering for same-base snapshots. A force-push away from head H and back to H
// produces the same deterministic base id; each distinct observation gets its own record so a
// STALE observation is never overwritten (which would resurrect it as CONSISTENT and erase the
// earlier receipt, violating SPEC exact-head staleness). Base is occurrence 1; re-observations
// after divergence are <base>-o2, -o3, ... mirroring beginEvaluation's occurrence suffix.
function snapshotOccurrenceIndex(base, id) {
  if (id === base) return 1;
  const match = /^-o(\d+)$/.exec(id.slice(base.length));
  return match ? Number(match[1]) : 1;
}

export function addPrSnapshot(capability, snapshot) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    const base = snapshot.id || `pr_${sha256(canonicalJson({ runId, snapshot })).slice(0, 24)}`;
    // Prior observations recorded under this deterministic base id (the same id recurs when the head
    // is force-pushed away and back). The latest one is the observation a re-snapshot is compared to.
    const priorOccurrences = Object.values(state.pr_snapshots)
      .filter((item) => item.id === base || item.id.startsWith(`${base}-o`));
    const latest = priorOccurrences.length
      ? priorOccurrences.reduce((a, b) => (snapshotOccurrenceIndex(base, b.id) > snapshotOccurrenceIndex(base, a.id) ? b : a))
      : null;
    // Divergence signal: the latest observation at this id went STALE, or an intervening pr_refreshed
    // observed a head different from that observation's head after its own snapshot event. Either way
    // the head has since moved, so a re-snapshot is a NEW observation, not an overwrite of the old one.
    let diverged = false;
    if (latest) {
      if (latest.status === 'STALE') {
        diverged = true;
      } else {
        const { events } = parseLedger(runId);
        const latestSnapshotSeq = events.find((event) => event.type === 'pr_snapshot' && event.payload.id === latest.id)?.seq ?? 0;
        diverged = events.some((event) => event.type === 'pr_refreshed'
          && event.payload.snapshot_id === latest.id
          && event.seq > latestSnapshotSeq
          && event.payload.observed_head !== latest.head_after);
      }
    }
    // No prior observation: the base id. Diverged: a fresh occurrence-suffixed id and its own ledger
    // event (the id in the idempotency key carries the occurrence, so it never dedupes against the
    // first observation). Plain retry (prior observation, no divergence): the same id — an idempotent
    // re-read that dedupes its event and must NOT resurrect the existing record's status or drop fields.
    const id = !latest ? base : diverged ? `${base}-o${priorOccurrences.length + 1}` : latest.id;
    const normalized = { ...snapshot, id };
    const snapshotEvent = appendEventUnlocked(runId, state, {
      type: 'pr_snapshot',
      origin: 'github_observed',
      payload: {
        id,
        repository: normalized.repository,
        pr_number: normalized.pr_number,
        head_before: normalized.head_before,
        head_after: normalized.head_after,
        status: normalized.status,
        counts: {
          files: normalized.files?.length || 0,
          checks: normalized.checks?.length || 0,
          reviews: normalized.reviews?.length || 0,
          review_comments: normalized.review_comments?.length || 0,
          issue_comments: normalized.issue_comments?.length || 0
        },
        failures: normalized.failures || []
      },
      idempotencyKey: `snapshot:${id}`
    });
    // Plain retry keeps the existing record untouched (no status resurrection, no lost refresh state);
    // a new (base or occurrence) observation is stored as itself.
    const storedSnapshot = {
      ...normalized,
      id: snapshotEvent.payload.id,
      base_sha: proofSafeGitObjectId(normalized.base_sha),
      head_before: snapshotEvent.payload.head_before,
      head_after: snapshotEvent.payload.head_after,
      current_head: proofSafeGitObjectId(normalized.current_head),
      failures: snapshotEvent.payload.failures || []
    };
    if (latest && !diverged) state.pr_snapshots[id] ||= storedSnapshot;
    else state.pr_snapshots[id] = storedSnapshot;
    saveState(state);
    return state.pr_snapshots[id];
  });
}

export function beginEvaluation(capability, snapshotId, checkout = {}, trigger = 'unspecified') {
  const { runId } = requireParent(capability);
  const normalizedTrigger = EVALUATION_TRIGGERS.has(trigger) ? trigger : 'unspecified';
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    assertParentLeaseUnlocked(runId, current, capability);
    const snapshot = current.pr_snapshots[snapshotId];
    assert(snapshot, 'SNAPSHOT_NOT_FOUND');
    assert(snapshot.status === 'CONSISTENT', 'INCONSISTENT_SNAPSHOT');
    assert(checkout.path && checkout.head === snapshot.head_after && checkout.clean === true && checkout.detached === true, 'EVALUATOR_CHECKOUT_REQUIRED');
    const snapshotEvaluations = Object.values(current.evaluations).filter((item) => item.snapshot_id === snapshotId);
    // Retry idempotency: while an evaluation for this snapshot is unfinished — non-terminal
    // (OPEN/CLAIMED), or recorded but its child receipt not yet sealed and retrieved —
    // begin_evaluation returns it unchanged so a repeated request keeps the first trigger and status.
    const active = snapshotEvaluations.find((item) => !isEvaluationFinished(item));
    if (active) return active;
    // Every prior evaluation for this snapshot finished. A fresh begin_evaluation
    // — e.g. a re-examination of an unchanged head that snapshotted to the same deterministic id —
    // creates a NEW evaluation with a deterministic occurrence-suffixed id (derived from the count of
    // prior evaluations, no clock or randomness) so same-head evaluations stay distinct, each carrying
    // its own trigger.
    const base = `eval_${sha256(`${runId}:${snapshotId}`).slice(0, 24)}`;
    const id = snapshotEvaluations.length === 0 ? base : `${base}-r${snapshotEvaluations.length + 1}`;
    appendEventUnlocked(runId, current, {
      type: 'evaluation_requested',
      origin: 'mcp_routed',
      payload: { evaluation_request_id: id, snapshot_id: snapshotId, expected_head: snapshot.head_after, trigger: normalizedTrigger },
      idempotencyKey: `evaluation-request:${id}`
    });
    current.evaluations[id] = {
      id,
      snapshot_id: snapshotId,
      expected_head: snapshot.head_after,
      status: 'OPEN',
      trigger: normalizedTrigger,
      child_capability_hash: null,
      child_agent_hash: null,
      checkout_path_ref: reference(checkout.path),
      checkout_head_before: checkout.head,
      checkout_clean_before: checkout.clean,
      checkout_detached_before: checkout.detached,
      findings: []
    };
    saveState(current);
    return current.evaluations[id];
  });
}

export function claimEvaluation(childCapability, evaluationId) {
  const { runId } = requireChild(childCapability);
  const childHash = sha256(childCapability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    const record = assertChildLeaseUnlocked(runId, current, childCapability);
    assert(childHash !== current.parent_capability_hash, 'SELF_REVIEW_REJECTED');
    const item = current.evaluations[evaluationId];
    assert(item, 'EVALUATION_NOT_FOUND');
    assert(!item.child_capability_hash, 'EVALUATION_ALREADY_CLAIMED');
    assert(item.status === 'OPEN', 'EVALUATION_NOT_CLAIMABLE');
    appendEventUnlocked(runId, current, {
      type: 'evaluation_claimed',
      origin: 'mcp_routed',
      payload: { evaluation_request_id: evaluationId, child_agent_hash: record.agent_hash },
      idempotencyKey: `evaluation-claim:${evaluationId}:${record.agent_hash}`
    });
    item.child_capability_hash = childHash;
    item.child_agent_hash = record.agent_hash;
    item.status = 'CLAIMED';
    current.children ||= {};
    if (current.children[record.agent_hash]) current.children[record.agent_hash].role = 'evaluator';
    saveState(current);
    return item;
  });
}

export function recordEvaluation(childCapability, evaluationId, finding, evidenceRefs = [], checkout = {}) {
  const { runId } = requireChild(childCapability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    const record = assertChildLeaseUnlocked(runId, current, childCapability);
    const item = current.evaluations[evaluationId];
    assert(item, 'EVALUATION_NOT_FOUND');
    assert(item.child_capability_hash === sha256(childCapability), 'EVALUATOR_NOT_BOUND');
    assert(item.child_agent_hash === record.agent_hash, 'EVALUATOR_NOT_BOUND');
    assert(!item.child_receipt_id, 'EVALUATION_RECEIPT_SEALED');
    assert(['CLAIMED', 'RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(item.status), 'EVALUATION_NOT_RECORDABLE');
    const priorIntegrityException = item.status === 'CHECKOUT_INTEGRITY_EXCEPTION';
    const cleanBefore = checkout.clean_before ?? item.checkout_clean_before;
    const cleanAfter = checkout.clean_after ?? null;
    const observedHeadBefore = checkout.head_before ?? item.checkout_head_before;
    const observedHeadAfter = checkout.head_after ?? null;
    // Git identities are opaque structural controls in every privacy mode. Invalid caller strings
    // become an integrity exception, but never enter the ledger or mutable projection as prose.
    const headBefore = proofSafeGitObjectId(observedHeadBefore);
    const headAfter = proofSafeGitObjectId(observedHeadAfter);
    const detachedBefore = checkout.detached_before ?? item.checkout_detached_before;
    const detachedAfter = checkout.detached_after ?? null;
    const integrityOk = observedHeadBefore === item.expected_head && observedHeadAfter === item.expected_head
      && headBefore !== null && headAfter !== null
      && cleanBefore === true && cleanAfter === true && detachedBefore === true && detachedAfter === true;
    const findingOrdinal = item.findings.length + 1;
    const findingId = `finding_${sha256(canonicalJson({ run_id: runId, evaluation_id: evaluationId, ordinal: findingOrdinal })).slice(0, 24)}`;
    const payload = {
      ...sanitizeClaim(finding, evidenceRefs),
      ...(current.privacy_mode === 'proof' ? { finding_id: findingId, finding_ordinal: findingOrdinal } : {}),
      evaluation_request_id: evaluationId,
      expected_head: item.expected_head,
      checkout_head_before: headBefore,
      checkout_head_after: headAfter,
      checkout_clean_before: cleanBefore,
      checkout_clean_after: cleanAfter,
      checkout_detached_before: detachedBefore,
      checkout_detached_after: detachedAfter,
      checkout_integrity: integrityOk ? 'CONSISTENT_CLEAN' : 'CHECKOUT_INTEGRITY_EXCEPTION'
    };
    const findingAlreadyRecorded = current.privacy_mode === 'proof'
      ? false
      : item.findings.some((existing) => sha256(canonicalJson(existing)) === sha256(canonicalJson(payload)));
    const findingEvent = appendEventUnlocked(runId, current, {
      type: 'evaluation_finding',
      origin: 'evaluator_reported',
      payload,
      idempotencyKey: current.privacy_mode === 'proof'
        ? `evaluation-finding:${evaluationId}:${findingId}`
        : `evaluation-finding:${evaluationId}:${sha256(canonicalJson(payload))}`
    });
    if (!findingAlreadyRecorded) item.findings.push(findingEvent.payload);
    item.checkout_head_before = headBefore;
    item.checkout_head_after = headAfter;
    item.checkout_clean_before = cleanBefore;
    item.checkout_clean_after = cleanAfter;
    item.checkout_detached_before = detachedBefore;
    item.checkout_detached_after = detachedAfter;
    item.status = integrityOk && !priorIntegrityException ? 'RECORDED' : 'CHECKOUT_INTEGRITY_EXCEPTION';
    saveState(current);
    return item;
  });
}

export function markSnapshotRefreshed(capability, snapshotId, currentHead) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    assertParentLeaseUnlocked(runId, current, capability);
    const snapshot = current.pr_snapshots[snapshotId];
    assert(snapshot, 'SNAPSHOT_NOT_FOUND');
    const storedCurrentHead = proofSafeGitObjectId(currentHead);
    const stale = storedCurrentHead === null || storedCurrentHead !== snapshot.head_after;
    // A refresh after new evaluation activity is a distinct observation — the CURRENT label
    // depends on a pr_refreshed event later in the ledger than the final evaluation event
    // (requested OR finding), so the idempotency key carries both the evaluation count and the
    // recorded-finding count at refresh time. A refresh between begin_evaluation and
    // record_evaluation therefore cannot swallow the required post-finding refresh, while plain
    // retries (no intervening evaluation activity) still dedupe to one recorded observation.
    const snapshotEvaluations = Object.values(current.evaluations).filter((item) => item.snapshot_id === snapshotId);
    const evaluationCount = snapshotEvaluations.length;
    const findingCount = snapshotEvaluations.reduce((total, item) => total + (item.findings?.length || 0), 0);
    appendEventUnlocked(runId, current, {
      type: 'pr_refreshed',
      origin: 'github_observed',
      payload: { snapshot_id: snapshotId, observed_head: storedCurrentHead, status: stale ? 'STALE' : 'CURRENT_AT_REFRESH' },
      idempotencyKey: `refresh:${snapshotId}:${storedCurrentHead ?? 'invalid'}:e${evaluationCount}f${findingCount}`
    });
    current.pr_snapshots[snapshotId].current_head = storedCurrentHead;
    current.pr_snapshots[snapshotId].status = stale ? 'STALE' : current.pr_snapshots[snapshotId].status;
    if (stale) {
      for (const evaluation of Object.values(current.evaluations)) {
        if (evaluation.snapshot_id === snapshotId) evaluation.status = 'STALE';
      }
    }
    saveState(current);
    return { stale, current_head: storedCurrentHead };
  });
}

function compileAndRecordUnlocked(runId, state) {
  assert(state.claim_contract && state.claim_profile, 'CLAIM_CONTRACT_REQUIRED');
  const { events } = parseLedger(runId);
  const compiled = compileClaim({ profile: state.claim_profile, contract: state.claim_contract, events });
  const prior = [...events].reverse().find((event) => event.type === 'claim_compiled' && event.payload?.claim_contract_ref === state.claim_contract.claim_contract_ref);
  let event = prior;
  if (!prior || prior.payload?.input_digest !== compiled.input_digest) {
    event = appendEventUnlocked(runId, state, {
      type: 'claim_compiled',
      origin: 'runtime_hook',
      payload: {
        ...compiled,
        claim_contract_ref: state.claim_contract.claim_contract_ref,
        fold_version: CURRENT_FOLD_VERSION
      },
      idempotencyKey: `claim-compiled:${state.claim_contract.contract_id}:${compiled.input_digest}`
    });
  }
  state.compiled_claim = {
    ...compiled,
    claim_contract_ref: state.claim_contract.claim_contract_ref,
    compiled_event_ref: event ? `sha256:${event.event_hash}` : null
  };
  return state.compiled_claim;
}

export function declareClaimContract(capability, rawContract) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    assert(!state.claim_contract, 'CLAIM_CONTRACT_ALREADY_DECLARED');
    const issuedContractId = state.claim_contract_id || `contract_${sha256(canonicalJson({ kind: 'claim_contract', run_id: runId })).slice(0, 32)}`;
    assert(rawContract?.contract_id === undefined
      || rawContract?.contract_id === null
      || rawContract?.contract_id === issuedContractId, 'CONTRACT_ID_NOT_ISSUED');
    assert(rawContract?.objective_ref === undefined
      || rawContract?.objective_ref === null
      || rawContract?.objective_ref === state.objective_ref, 'OBJECTIVE_REF_NOT_ISSUED');
    const { contract, profile } = validateClaimContract({
      ...rawContract,
      contract_id: issuedContractId,
      objective_ref: state.objective_ref
    }, state.privacy_mode);
    const event = appendEventUnlocked(runId, state, {
      type: 'claim_contract_declared',
      origin: 'mcp_routed',
      payload: {
        contract,
        profile_structural: profile,
        profile_requirements_hash: contract.profile_requirements_hash
      },
      idempotencyKey: `claim-contract:${contract.contract_id}`
    });
    state.claim_contract = { ...contract, claim_contract_ref: `sha256:${event.event_hash}` };
    state.claim_profile = profile;
    compileAndRecordUnlocked(runId, state);
    saveState(state);
    return {
      ...state.claim_contract,
      status: 'DECLARED',
      compiled: state.compiled_claim
    };
  });
}

export function requestClaimProducer(capability, contractId, producerId) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    assert(state.claim_contract?.contract_id === contractId, 'CLAIM_CONTRACT_NOT_FOUND');
    assert(state.claim_contract.named_producers.includes(producerId), 'PRODUCER_NOT_DECLARED');
    const profile = getClaimProfile(state.claim_contract.profile_id);
    assert(profile.producers[producerId], 'UNREGISTERED_PRODUCER');
    const event = appendEventUnlocked(runId, state, {
      type: 'producer_requested',
      origin: 'mcp_routed',
      payload: {
        contract_id: contractId,
        claim_contract_ref: state.claim_contract.claim_contract_ref,
        producer_id: producerId,
        expected_identity: profile.producers[producerId].expected_identity
      },
      idempotencyKey: `producer-request:${contractId}:${producerId}`
    });
    const compiled = compileAndRecordUnlocked(runId, state);
    saveState(state);
    return { producer_id: producerId, status: 'REQUESTED', event_ref: `sha256:${event.event_hash}`, compiled };
  });
}

export function evaluateClaimGate(capability, contractId, gateId) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    assert(state.claim_contract?.contract_id === contractId, 'CLAIM_CONTRACT_NOT_FOUND');
    assert(state.claim_contract.declared_gate_ids.includes(gateId), 'GATE_NOT_DECLARED');
    const compiled = compileAndRecordUnlocked(runId, state);
    const { compiled_event_ref: _compiledEventRef, ...gatePayload } = compiled;
    appendEventUnlocked(runId, state, {
      type: 'gate_evaluated',
      origin: 'runtime_hook',
      payload: {
        ...gatePayload,
        gate_id: gateId,
        claim_contract_ref: state.claim_contract.claim_contract_ref,
        fold_version: CURRENT_FOLD_VERSION
      },
      idempotencyKey: `gate-evaluated:${contractId}:${gateId}:${compiled.input_digest}`
    });
    saveState(state);
    return { gate_id: gateId, ...compiled };
  });
}

function claimSupportPosition(compiled, contract) {
  const requestedSupported = compiled.state_results?.[contract.requested_state]?.supported === true;
  const supported = compiled.highest_supported_state || 'NO_SUPPORTED_STATE';
  return requestedSupported
    ? `evidence supports requested ${contract.requested_state}, but closeout is blocked`
    : `evidence supports ${supported}, not requested ${contract.requested_state}`;
}

function lifecycleProjectionFromEvents(events) {
  const projection = {
    children: new Map(), evaluations: new Map(), sealedReceipts: new Map(),
    retrievedReceipts: new Map(), staleSnapshots: new Set()
  };
  for (const event of events) applyLifecycleProjectionEvent(projection, event);
  return projection;
}

function applyLifecycleProjectionEvent(projection, event) {
  const payload = event.payload || {};
  if (event.type === 'child_started' && event.origin === 'runtime_hook') {
    projection.children.set(payload.child_id, { stopped: false, receipt_id: null });
  } else if (event.type === 'child_stop_observed' && event.origin === 'runtime_hook') {
    const child = projection.children.get(payload.child_id);
    if (child) child.stopped = true;
  } else if (event.type === 'evaluation_requested' && event.origin === 'mcp_routed') {
    projection.evaluations.set(payload.evaluation_request_id, {
      id: payload.evaluation_request_id,
      snapshot_id: payload.snapshot_id,
      status: projection.staleSnapshots.has(payload.snapshot_id) ? 'STALE' : 'OPEN',
      child_agent_hash: null
    });
  } else if (event.type === 'evaluation_claimed' && event.origin === 'mcp_routed') {
    const evaluation = projection.evaluations.get(payload.evaluation_request_id);
    if (evaluation && evaluation.status !== 'STALE') {
      evaluation.status = 'CLAIMED';
      evaluation.child_agent_hash = payload.child_agent_hash;
    }
  } else if (event.type === 'evaluation_finding' && event.origin === 'evaluator_reported') {
    const evaluation = projection.evaluations.get(payload.evaluation_request_id);
    if (evaluation && !['STALE', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(evaluation.status)) {
      evaluation.status = payload.checkout_integrity === 'CONSISTENT_CLEAN'
        ? 'RECORDED'
        : 'CHECKOUT_INTEGRITY_EXCEPTION';
    }
  } else if (event.type === 'pr_refreshed' && event.origin === 'github_observed' && payload.status === 'STALE') {
    projection.staleSnapshots.add(payload.snapshot_id);
    for (const evaluation of projection.evaluations.values()) {
      if (evaluation.snapshot_id === payload.snapshot_id) evaluation.status = 'STALE';
    }
  } else if (event.type === 'child_receipt_sealed' && event.origin === 'runtime_hook') {
    projection.sealedReceipts.set(payload.receipt_id, payload.content_ref);
  } else if (event.type === 'child_receipt_retrieved' && event.origin === 'mcp_routed') {
    projection.retrievedReceipts.set(payload.receipt_id, payload.content_ref);
  }
}

function lifecycleBlockersFromProjection(state, projection, verifyArtifacts = false) {
  const { children, evaluations, sealedReceipts, retrievedReceipts } = projection;
  if (verifyArtifacts) {
    // A ledger claim that a child receipt was sealed is joined only while the exact artifact still
    // exists and hashes to the witnessed content reference.
    for (const [receiptId, contentRef] of sealedReceipts) {
      const path = childReceiptPath(state.id, receiptId);
      assert(typeof contentRef === 'string' && contentRef.length > 0 && existsSync(path), 'LOCAL_CHAIN_BROKEN');
      assert(sha256(readFileSync(path, 'utf8')) === contentRef, 'LOCAL_CHAIN_BROKEN');
    }
  }
  const blockers = [];
  for (const evaluation of evaluations.values()) {
    if (evaluation.status === 'STALE' || evaluation.status === 'INVALID') continue;
    if (!['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(evaluation.status)) {
      blockers.push(`EVALUATION_${evaluation.id}_${evaluation.status}`);
    }
    const receiptId = `child_${evaluation.id}`;
    const sealedRef = sealedReceipts.get(receiptId);
    if (!sealedRef) blockers.push(`CHILD_RECEIPT_${evaluation.id}_OPEN`);
    if (!sealedRef || retrievedReceipts.get(receiptId) !== sealedRef) {
      blockers.push(`CHILD_RECEIPT_${evaluation.id}_NOT_RETRIEVED`);
    }
  }
  for (const [childId, child] of children) {
    const evaluatorReceipt = [...evaluations.values()].find((evaluation) => (
      evaluation.child_agent_hash
      && childId === `child_agent_${sha256(`${state.id}\0${evaluation.child_agent_hash}`).slice(0, 24)}`
    ));
    const receiptId = evaluatorReceipt ? `child_${evaluatorReceipt.id}` : childId;
    child.receipt_id = sealedReceipts.has(receiptId) ? receiptId : null;
    if (!child.stopped || !child.receipt_id) blockers.push(`CHILD_${childId}_OPEN`);
  }
  return [...new Set(blockers)].sort();
}

function claimLifecycleBlockers(state, ledgerEvents = null) {
  // Lifecycle caches are UI projections, never closeout authority. Rebuild once from witnessed
  // events; artifact verification remains on the authoritative closeout path, not streak replay.
  const events = ledgerEvents || parseLedger(state.id).events;
  return lifecycleBlockersFromProjection(state, lifecycleProjectionFromEvents(events), true);
}

function claimCloseoutBlockers(state, compiled, ledgerEvents = null) {
  return [...new Set([
    ...compiled.missing.map((item) => `MISSING_${item}`),
    ...compiled.pending_producers.map((item) => `PENDING_${item}`),
    ...compiled.contradictions,
    ...(compiled.currentness === 'AS_WITNESSED' ? [] : ['CURRENTNESS_UNPROVEN']),
    ...claimLifecycleBlockers(state, ledgerEvents)
  ])].sort();
}

function claimCloseoutBlockerFingerprint(state, gateId, compiled, ledgerEvents = null) {
  return sha256(canonicalJson({
    contract_id: state.claim_contract.contract_id,
    gate_id: gateId,
    requested_state: state.claim_contract.requested_state,
    blockers: claimCloseoutBlockers(state, compiled, ledgerEvents),
    eligible_evidence_frontier: compiled.eligible_evidence_frontier
  }));
}

function resolveClaimDiagnosticUnlocked(runId, state, compiled) {
  const prior = state.claim_diagnostic;
  if (prior?.status !== 'OPEN') return false;
  appendEventUnlocked(runId, state, {
    type: 'diagnostic_resolved',
    origin: 'runtime_hook',
    payload: {
      diagnostic_id: prior.diagnostic_id,
      diagnostic_status: 'RESOLVED',
      claim_contract_ref: state.claim_contract.claim_contract_ref,
      fold_version: CURRENT_FOLD_VERSION,
      input_digest: compiled.input_digest,
      eligible_evidence_frontier: compiled.eligible_evidence_frontier,
      material_control_frontier: compiled.material_control_frontier,
      blocker_fingerprint: prior.blocker_fingerprint
    },
    idempotencyKey: `diagnostic-resolved:${prior.diagnostic_id}:${compiled.input_digest}`
  });
  state.claim_diagnostic = { ...prior, status: 'RESOLVED', input_digest: compiled.input_digest };
  return true;
}

function ensureClaimDiagnosticUnlocked(runId, state, compiled, fingerprint, message) {
  const prior = state.claim_diagnostic;
  if (prior?.status === 'OPEN' && prior.blocker_fingerprint === fingerprint) {
    return { diagnostic: prior, emitted: false };
  }
  resolveClaimDiagnosticUnlocked(runId, state, compiled);
  const priorOccurrences = parseLedger(runId).events.filter((event) => (
    event.type === 'diagnostic_emitted' && event.payload?.blocker_fingerprint === fingerprint
  )).length;
  const occurrence = priorOccurrences + 1;
  const diagnosticId = `diag_${sha256(canonicalJson({ fingerprint, occurrence })).slice(0, 24)}`;
  const event = appendEventUnlocked(runId, state, {
    type: 'diagnostic_emitted',
    origin: 'runtime_hook',
    payload: {
      diagnostic_id: diagnosticId,
      diagnostic_status: 'OPEN',
      claim_contract_ref: state.claim_contract.claim_contract_ref,
      fold_version: CURRENT_FOLD_VERSION,
      input_digest: compiled.input_digest,
      eligible_evidence_frontier: compiled.eligible_evidence_frontier,
      material_control_frontier: compiled.material_control_frontier,
      blocker_fingerprint: fingerprint,
      supported_state: compiled.highest_supported_state,
      requested_state: state.claim_contract.requested_state,
      missing: compiled.missing,
      next_verifier: compiled.next_verifier,
      message
    },
    idempotencyKey: `diagnostic:${fingerprint}:o${occurrence}`
  });
  const diagnostic = {
    diagnostic_id: diagnosticId,
    status: 'OPEN',
    input_digest: event.payload.input_digest,
    blocker_fingerprint: fingerprint
  };
  state.claim_diagnostic = diagnostic;
  return { diagnostic, emitted: true };
}

export function claimInlineAdvisory(capability) {
  const runId = activeRunFor(capability);
  if (!runId) return null;
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    if (state.sealed || !state.claim_contract) return null;
    const compiled = compileAndRecordUnlocked(runId, state);
    const requestedSupported = compiled.state_results?.[state.claim_contract.requested_state]?.supported === true;
    const inlineBlockers = claimCloseoutBlockers(state, compiled);
    if (requestedSupported && inlineBlockers.length === 0) {
      if (resolveClaimDiagnosticUnlocked(runId, state, compiled)) saveState(state);
      return null;
    }
    const gateId = state.claim_contract.declared_gate_ids[0];
    const fingerprint = claimCloseoutBlockerFingerprint(state, gateId, compiled);
    const claimPosition = claimSupportPosition(compiled, state.claim_contract);
    const message = `Lyhna inline claim check: ${claimPosition}. Blockers: ${inlineBlockers.join(', ') || 'REQUESTED_STATE_UNSUPPORTED'}. Next verifier: ${compiled.next_verifier}.`;
    const result = ensureClaimDiagnosticUnlocked(runId, state, compiled, fingerprint, message);
    saveState(state);
    return result.emitted ? message : null;
  });
}

export function requestClose(capability, reason) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assertParentLeaseUnlocked(runId, state, capability);
    const requestOrdinal = parseLedger(runId).events.filter((event) => event.type === 'close_requested').length + 1;
    const requestId = `close_${sha256(canonicalJson({ run_id: runId, ordinal: requestOrdinal })).slice(0, 24)}`;
    const payload = state.privacy_mode === 'proof'
      ? { request_id: requestId, text_withheld: true }
      : { request_id: requestId, reason: structuralSummary(reason, 'Close reason'), reason_ref: sha256(String(reason || '')) };
    appendEventUnlocked(runId, state, { type: 'close_requested', origin: 'mcp_routed', payload, idempotencyKey: `close:${sha256(canonicalJson(payload))}` });
    state.close_requested = payload;
    saveState(state);
    return { run_id: runId, close_requested: true };
  });
}

export function sealChildByAgent({ sessionId, agentId, hookPayload = null, hookDeliveryKey = null }) {
  const parentCapability = findParentCapabilityBySession(sessionId);
  if (!parentCapability) return null;
  const parentRecord = getCapability(parentCapability);
  const agentHash = sha256(String(agentId || ''));
  const routePath = migratedChildRoutePath(parentRecord.session_hash, agentHash);
  const migratedRoute = readJson(routePath, null);
  const runId = activeRunFor(parentCapability) || migratedRoute?.run_id;
  if (!runId) return null;
  const finishRoute = (value) => {
    if (migratedRoute) rmSync(routePath, { force: true });
    return value;
  };
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    recoverClaimControlStateUnlocked(runId, current);
    let stopEvent = null;
    if (hookPayload) {
      assert(current.privacy_mode !== 'proof' || /^hook:[^:]+:id_[a-f0-9]{64}$/.test(String(hookDeliveryKey || '')), 'PROOF_HOOK_DELIVERY_ID_REQUIRED');
      stopEvent = appendEventUnlocked(runId, current, {
        type: 'hook_subagentstop',
        origin: 'runtime_hook',
        payload: hookPayload,
        idempotencyKey: hookDeliveryKey || `hook:SubagentStop:${sha256(canonicalJson(hookPayload))}`
      });
    }
    current.children ||= {};
    const child = current.children[agentHash];
    if (child) {
      const childStoppedEvent = appendEventUnlocked(runId, current, {
        type: 'child_stop_observed',
        origin: 'runtime_hook',
        payload: { child_id: child.id, role: child.role, status: 'STOP_OBSERVED' },
        idempotencyKey: `child-stop:${child.id}`
      });
      child.status = 'STOP_OBSERVED';
      child.stop_event_ref = stopEvent?.event_hash || childStoppedEvent.event_hash;
    }
    const recordable = Object.values(current.evaluations).filter((item) => (
      item.child_agent_hash === agentHash
      && ['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(item.status)
    ));
    const evaluation = recordable.find((item) => !item.child_receipt_id) || recordable.find((item) => item.child_receipt_id);
    if (evaluation?.child_receipt_id) {
      atomicWriteJson(receiptIndexPath(evaluation.child_receipt_id), { receipt_id: evaluation.child_receipt_id, run_id: runId });
      saveState(current);
      return finishRoute(withChildReceiptPath(runId, current.child_receipts[evaluation.child_receipt_id]));
    }

    const assignedEvaluation = Object.values(current.evaluations).find((item) => item.child_agent_hash === agentHash);
    if (!evaluation && !child) {
      saveState(current);
      return finishRoute(null);
    }

    const receiptId = evaluation ? `child_${evaluation.id}` : child.id;
    if (!evaluation && child.receipt_id) {
      atomicWriteJson(receiptIndexPath(child.receipt_id), { receipt_id: child.receipt_id, run_id: runId });
      saveState(current);
      return finishRoute(withChildReceiptPath(runId, current.child_receipts[child.receipt_id]));
    }
    const role = evaluation || assignedEvaluation ? 'evaluator' : 'delegated_agent';
    const status = evaluation ? evaluation.status : 'STOP_OBSERVED';
    const receipt = evaluation ? {
      schema: 'lyhna.codex.child-receipt.v0',
      id: receiptId,
      role,
      evaluation_id: evaluation.id,
      expected_head: evaluation.expected_head,
      status,
      findings: evaluation.findings,
      ...(child ? {
        lifecycle: {
          start: {
            origin: 'runtime_hook',
            support: 'lifecycle_observed_not_execution',
            event_ref: child.start_event_ref
          },
          stop: {
            origin: 'runtime_hook',
            support: 'lifecycle_observed_not_execution',
            event_ref: child.stop_event_ref
          }
        }
      } : {})
    } : {
      schema: 'lyhna.codex.child-receipt.v0',
      id: receiptId,
      role,
      status,
      lifecycle: {
        start: {
          origin: 'runtime_hook',
          support: 'lifecycle_observed_not_execution',
          event_ref: child.start_event_ref
        },
        stop: {
          origin: 'runtime_hook',
          support: 'lifecycle_observed_not_execution',
          event_ref: child.stop_event_ref
        }
      },
      limitations: [
        'This child receipt records lifecycle coverage only; it does not claim what the delegated agent inspected, changed, or completed.'
      ],
      ...(assignedEvaluation ? {
        evaluation_id: assignedEvaluation.id,
        evaluation_status: assignedEvaluation.status
      } : {})
    };
    const path = childReceiptPath(runId, receiptId);
    const content = canonicalJson(receipt, true);
    const contentHash = sha256(content);
    atomicWriteText(path, content);
    appendEventUnlocked(runId, current, {
      type: 'child_receipt_sealed',
      origin: 'runtime_hook',
      payload: { receipt_id: receiptId, role, status, content_ref: contentHash },
      idempotencyKey: `child-seal:${receiptId}`
    });
    current.child_receipts[receiptId] = { id: receiptId, role, status, content_hash: contentHash, retrieved: false };
    if (evaluation) evaluation.child_receipt_id = receiptId;
    if (child) {
      child.role = role;
      child.status = 'STOP_OBSERVED';
      child.receipt_id = receiptId;
    }
    atomicWriteJson(receiptIndexPath(receiptId), { receipt_id: receiptId, run_id: runId });
    saveState(current);
    return finishRoute(withChildReceiptPath(runId, current.child_receipts[receiptId]));
  });
}

export function listChildReceipts(capability) {
  const { state } = requireParent(capability, { mutable: false });
  return Object.values(state.child_receipts).map(({ path: _path, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id));
}

export function readSealedReceipt(capability, receiptId) {
  const parent = getCapability(capability);
  assert(parent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  let runId = activeRunFor(capability, { includeSealed: true });
  let initial = runId ? loadState(runId) : null;
  if (!initial?.child_receipts?.[receiptId]) {
    const index = readJson(receiptIndexPath(receiptId), null);
    assert(index?.receipt_id === receiptId && index.run_id, 'CHILD_RECEIPT_NOT_FOUND');
    runId = index.run_id;
    initial = loadState(runId);
    assert(initial.sealed, 'CHILD_RECEIPT_NOT_SEALED');
  }
  assert(initial.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    if (!current.sealed) assertParentLeaseUnlocked(runId, current, capability);
    else assert(current.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
    if (current.sealed) repairSeal(runId);
    const receipt = current.child_receipts[receiptId];
    assert(receipt, 'CHILD_RECEIPT_NOT_FOUND');
    const content = readFileSync(childReceiptPath(runId, receiptId), 'utf8');
    assert(receipt.content_hash === sha256(content), 'LOCAL_CHAIN_BROKEN');
    if (current.sealed) return JSON.parse(content);
    appendEventUnlocked(runId, current, {
      type: 'child_receipt_retrieved',
      origin: 'mcp_routed',
      payload: { receipt_id: receiptId, content_ref: sha256(content) },
      idempotencyKey: `child-read:${receiptId}`
    });
    current.child_receipts[receiptId].retrieved = true;
    const evaluation = Object.values(current.evaluations).find((item) => item.child_receipt_id === receiptId);
    if (evaluation) evaluation.child_receipt_retrieved = true;
    saveState(current);
    return JSON.parse(content);
  });
}

function finalizeRunSealUnlocked(runId, current, terminalStatus = 'SEALED', sealPayload = {}) {
  appendEventUnlocked(runId, current, {
    type: 'run_sealed',
    origin: 'runtime_hook',
    payload: {
      status: terminalStatus,
      receipt_renderer: ADAPTER_VERSION,
      continuation_fold_version: CURRENT_FOLD_VERSION,
      ...sealPayload
    },
    idempotencyKey: `seal:${runId}`
  });
  const { events, tip } = parseLedger(runId);
  stripLegacyChildReceiptPaths(current);
  current.sealed = true;
  current.terminal_status = terminalStatus;
  current.ledger_count = events.length;
  current.ledger_tip = tip;
  saveState(current);
  const receiptJson = renderReceiptJson(current, events);
  const receiptMarkdown = renderReceiptMarkdown(current, events);
  atomicWriteText(join(runDir(runId), 'receipt.json'), receiptJson);
  atomicWriteText(join(runDir(runId), 'RECEIPT.md'), receiptMarkdown);
  const capsule = writeContinuationArtifacts(runId, current, events);
  atomicWriteJson(capsuleIndexPath(capsule.capsule_ref), { run_id: runId, capsule_ref: capsule.capsule_ref });
  atomicWriteJson(anchorPath(runId), {
    run_id: runId,
    final_seq: current.ledger_count,
    final_hash: current.ledger_tip,
    state_hash: sha256(canonicalJson(current)),
    receipt_json_hash: sha256(receiptJson),
    receipt_markdown_hash: sha256(receiptMarkdown),
    receipt_renderer: ADAPTER_VERSION
  });
  dropCheckpointAnchor(runId);
  return {
    status: terminalStatus,
    run_id: runId,
    receipt_path: join(runDir(runId), 'RECEIPT.md'),
    handoff_path: join(runDir(runId), 'HANDOFF.md'),
    continuation_path: join(runDir(runId), 'continuation.json'),
    capsule_ref: capsule.capsule_ref
  };
}

function storedStopCheckpointKey(privacyMode, checkpointKey) {
  return privacyMode === 'proof'
    ? `idempotency_${sha256(checkpointKey)}`
    : checkpointKey;
}

function stopDeliverySlotRef(deliveryKey, slot) {
  return `stop_slot_${sha256(canonicalJson({ delivery_key: deliveryKey, slot }))}`;
}

function stopCheckpointForSlot(events, privacyMode, deliveryKey, slot) {
  const rawKeys = [`checkpoint:${deliveryKey}#${slot}`];
  // v0.1.33 wrote the first delivery checkpoint without an explicit slot. Recognize that shape as
  // slot zero so an already-open installed packet advances instead of starting a second slot zero.
  if (slot === 0) rawKeys.push(`checkpoint:${deliveryKey}`);
  const storedKeys = new Set(rawKeys.map((key) => storedStopCheckpointKey(privacyMode, key)));
  const matches = events.filter((event) => (
    event.type === 'turn_checkpoint' && storedKeys.has(event.idempotency_key)
  ));
  assert(matches.length <= 1, 'STOP_CHECKPOINT_SLOT_CONFLICT');
  return matches[0] || null;
}

function stopAttemptForSlot(events, privacyMode, deliveryKey, slot, checkpoint = null) {
  const slotRef = stopDeliverySlotRef(deliveryKey, slot);
  const matches = events.filter((event) => (
    event.type === 'closeout_attempted' && event.payload?.delivery_slot_ref === slotRef
  ));
  assert(matches.length <= 1, 'STOP_ATTEMPT_SLOT_CONFLICT');
  if (matches.length === 1) return matches[0];
  // Pre-slot packets did not carry a delivery_slot_ref. Only slot zero can have that shape, and its
  // attempt is the first closeout attempt before another Stop checkpoint.
  if (slot !== 0) return null;
  const slotCheckpoint = checkpoint || stopCheckpointForSlot(events, privacyMode, deliveryKey, slot);
  if (!slotCheckpoint) return null;
  const nextCheckpoint = events.find((event) => (
    event.seq > slotCheckpoint.seq && event.type === 'turn_checkpoint'
  ));
  return events.find((event) => (
    event.seq > slotCheckpoint.seq
    && (!nextCheckpoint || event.seq < nextCheckpoint.seq)
    && event.type === 'closeout_attempted'
    && !event.payload?.delivery_slot_ref
  )) || null;
}

function completedAttemptsUnderDeliveryKey(events, privacyMode, deliveryKey) {
  let slot = 0;
  while (slot <= events.length) {
    const checkpoint = stopCheckpointForSlot(events, privacyMode, deliveryKey, slot);
    if (!checkpoint) return slot;
    const attempt = stopAttemptForSlot(events, privacyMode, deliveryKey, slot, checkpoint);
    const completed = attempt && closeoutAttemptCompleted(events, attempt);
    // An incomplete slot is replayed in place so torn checkpoint, attempt, and envelope writes keep
    // their existing recovery semantics. Only a fully published blocked attempt spends the slot.
    if (!attempt || !completed) return slot;
    slot += 1;
  }
  throw Object.assign(new Error('STOP_CHECKPOINT_SLOT_RANGE'), { code: 'STOP_CHECKPOINT_SLOT_RANGE' });
}

function closeoutAttemptCompleted(events, attempt) {
  const slotRef = attempt.payload?.delivery_slot_ref;
  const nextCheckpoint = events.find((event) => (
    event.seq > attempt.seq && event.type === 'turn_checkpoint'
  ));
  return events.some((event) => {
    if (event.seq <= attempt.seq) return false;
    if (event.type === 'checkpoint_anchor') {
      // New anchors name the exact delivery slot they publish. Older anchors remain readable only
      // when they occur before another Stop checkpoint, which is the only unambiguous legacy shape.
      if (event.payload?.delivery_slot_ref) return event.payload.delivery_slot_ref === slotRef;
      return !nextCheckpoint || event.seq < nextCheckpoint.seq;
    }
    return event.type === 'closeout_envelope_generated'
      && (!nextCheckpoint || event.seq < nextCheckpoint.seq);
  });
}

export function checkpointOrSeal(capability, deliveryKey = null) {
  const runId = locateOpenClaimRunForParent(capability);
  if (!runId) return { status: 'NO_ACTIVE_RUN' };
  let claimBoundary = false;
  try {
    return withLock(lockPath(runId), () => {
    // The ledger, not the mutable state cache, decides whether this caller owns an open claim
    // boundary. This both fails closed when state.json is missing and avoids blocking a predecessor
    // after a durable lease transfer whose state projection has not yet caught up.
    let parsedBeforeState;
    try {
      parsedBeforeState = parseLedger(runId);
    } catch (error) {
      // If the chain itself cannot be read, the last intact cache may only be used to choose the
      // transport posture; it never repairs or evidences the run. A cached current owner with a
      // declared open contract still fails closed.
      const cached = readJson(statePath(runId), null);
      claimBoundary = Boolean(cached?.claim_contract && !cached?.sealed
        && cached?.parent_capability_hash === sha256(capability));
      throw error;
    }
    const contractDeclared = parsedBeforeState.events.some((event) => event.type === 'claim_contract_declared');
    const sealedInLedger = parsedBeforeState.events.some((event) => event.type === 'run_sealed');
    const latestLease = [...parsedBeforeState.events].reverse().find((event) => event.type === 'continuation_lease_transferred');
    claimBoundary = contractDeclared && !sealedInLedger && (
      !latestLease || latestLease.payload?.successor_parent_ref === sha256(capability)
    );
    const current = loadState(runId);
    recoverClaimControlStateUnlocked(runId, current, parsedBeforeState);
    assert(current.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
    if (current.privacy_mode === 'proof') {
      assert(/^id_[a-f0-9]{64}$/.test(String(deliveryKey || '')), 'STOP_DELIVERY_ID_REQUIRED');
    } else if (current.claim_contract) {
      assert(typeof deliveryKey === 'string' && deliveryKey.length > 0, 'STOP_DELIVERY_ID_REQUIRED');
    }
    atomicWriteJson(activePath(capability), { run_id: runId });
    // Adopt a durable terminal run_sealed (crash after the seal append, before state/anchor) BEFORE the
    // replay guard, which would otherwise short-circuit and leave an unsealed run no later Stop repairs.
    const { events: preEvents } = adoptTerminalLedgerSeal(runId, current);
    if (current.sealed) {
      return repairSeal(runId);
    }
    // A closeout envelope is itself the durable decision to terminate. If the process died after
    // appending it but before run_sealed, a delivery replay must finish that same seal rather than
    // taking the generic checkpoint replay branch and leaving the run open forever.
    const pendingEnvelope = [...preEvents].reverse().find((event) => event.type === 'closeout_envelope_generated');
    if (pendingEnvelope) {
      const outcome = pendingEnvelope.payload?.outcome;
      assert(pendingEnvelope.seq === preEvents.at(-1)?.seq, 'CLOSEOUT_ENVELOPE_TAIL');
      validateCloseoutEnvelopeBinding(current, pendingEnvelope.origin, pendingEnvelope.payload);
      current.closeout_envelope = { ...pendingEnvelope.payload, event_ref: `sha256:${pendingEnvelope.event_hash}` };
      return finalizeRunSealUnlocked(runId, current, outcome === 'CLOSED_UNSUPPORTED' ? 'CLOSED_UNSUPPORTED' : 'SEALED', {
        claim_contract_ref: current.claim_contract?.claim_contract_ref || null,
        supported_state: pendingEnvelope.payload?.supported_state ?? null,
        requested_state: pendingEnvelope.payload?.requested_state ?? null,
        closeout_envelope_ref: current.closeout_envelope.event_ref
      });
    }
    // Every Stop records exactly one delivery-keyed turn_checkpoint — the "a Stop boundary was
    // observed" fact — and repeated-hook idempotency (SPEC) requires a replayed Stop to NOT re-observe
    // the run: no new close_deferred, no seal. A replay is identified by its delivery-keyed checkpoint
    // ALREADY existing in the ledger, checked before anything is appended. (Inferring it from tip
    // position would miss the crash window where the turn_checkpoint was appended and state saved but
    // the closeout never ran — the dup would still be the tip, so a redelivery would wrongly seal.)
    // Older non-contract runs may arrive without a host delivery ID. Bind their fallback to the
    // latest non-checkpoint frontier instead of the ledger length: a replay after checkpoint
    // artifacts then resolves to the same key, while real intervening work creates a new boundary.
    // Contracted runs never use this fallback; they fail closed above when the host ID is absent.
    const legacyStopFrontier = [...preEvents].reverse().find((event) => (
      !['turn_checkpoint', 'checkpoint_anchor', 'close_deferred'].includes(event.type)
    ))?.event_hash || ZERO_HASH;
    const contractedCloseoutDelivery = Boolean(current.close_requested && current.claim_contract && deliveryKey);
    const completedDeliveryAttempts = contractedCloseoutDelivery
      ? completedAttemptsUnderDeliveryKey(preEvents, current.privacy_mode, deliveryKey)
      : null;
    const checkpointKey = contractedCloseoutDelivery
      ? `checkpoint:${deliveryKey}#${completedDeliveryAttempts}`
      : `checkpoint:${deliveryKey || `auto_${legacyStopFrontier}`}`;
    const storedCheckpointKey = storedStopCheckpointKey(current.privacy_mode, checkpointKey);
    const priorCheckpoint = contractedCloseoutDelivery
      ? stopCheckpointForSlot(preEvents, current.privacy_mode, deliveryKey, completedDeliveryAttempts)
      : preEvents.find((event) => event.idempotency_key === storedCheckpointKey);
    if (contractedCloseoutDelivery && completedDeliveryAttempts > 0) {
      const priorSameDeliveryAttempt = stopAttemptForSlot(
        preEvents,
        current.privacy_mode,
        deliveryKey,
        completedDeliveryAttempts - 1
      );
      assert(priorSameDeliveryAttempt, 'STOP_DELIVERY_ATTEMPT_MISSING');
      const gateId = current.claim_contract.declared_gate_ids[0];
      const preview = compileClaim({
        profile: current.claim_profile,
        contract: current.claim_contract,
        events: preEvents
      });
      const previewRequestedSupported = preview.state_results?.[current.claim_contract.requested_state]?.supported === true;
      const previewBlockers = claimCloseoutBlockers(current, preview, preEvents);
      const wouldSealSuccessfully = previewRequestedSupported && previewBlockers.length === 0;
      if (wouldSealSuccessfully) {
        // A completed delivery identity can spend another bounded blocked attempt, but it can never
        // be reused for a successful seal. Do not append a checkpoint, compile, attempt, or derived
        // artifact for this ambiguous observation: the existing face remains the prior published
        // boundary, while this response is computed from the fresh in-memory compile. A fresh host
        // identity is the only path that may publish and seal the newly successful frontier.
        return {
          status: 'CLOSE_DEFERRED',
          run_id: runId,
          blockers: previewBlockers,
          decision: 'block',
          reason: 'STOP_DELIVERY_FRONTIER_CHANGED: This reused Stop delivery identity would change the closeout decision to a successful seal. The run remains open; continue with a fresh Stop delivery identity.',
          replayed_delivery: true,
          compiled: preview
        };
      }
    }
    let resumeCloseoutAfterCheckpoint = false;
    if (priorCheckpoint) {
      const interruptedAttempt = contractedCloseoutDelivery
        ? stopAttemptForSlot(
          preEvents,
          current.privacy_mode,
          deliveryKey,
          completedDeliveryAttempts,
          priorCheckpoint
        )
        : null;
      const attemptCompleted = interruptedAttempt && closeoutAttemptCompleted(preEvents, interruptedAttempt);
      if (interruptedAttempt) {
        validateCloseoutAttemptBinding(
          current,
          interruptedAttempt.origin,
          interruptedAttempt.payload,
          interruptedAttempt.seq
        );
        const { bindingState: attemptState } = closeoutAttemptBindingState(
          current,
          interruptedAttempt.seq,
          preEvents
        );
        const blockers = [...(interruptedAttempt.payload?.blockers || [])];
        const ordinal = Number(interruptedAttempt.payload?.ordinal || 0);
        const requested = attemptState.claim_contract?.requested_state || 'UNDECLARED_STATE';
        const nextVerifier = attemptState.compiled_claim?.next_verifier || 'not available';
        assert(attemptState.claim_contract && ordinal > 0, 'INVALID_CLOSEOUT_ATTEMPT');
        const reason = `Lyhna ${claimSupportPosition(attemptState.compiled_claim, attemptState.claim_contract)}. Missing or conflicting evidence: ${blockers.join(', ') || 'REQUESTED_STATE_UNSUPPORTED'}. Next verifier: ${nextVerifier}.`;
        const currentMatchesAttempt = current.compiled_claim?.input_digest === interruptedAttempt.payload?.input_digest
          && current.compiled_claim?.eligible_evidence_frontier === interruptedAttempt.payload?.eligible_evidence_frontier
          && current.compiled_claim?.material_control_frontier === interruptedAttempt.payload?.material_control_frontier;
        if (currentMatchesAttempt) {
          ensureClaimDiagnosticUnlocked(
            runId,
            current,
            current.compiled_claim,
            interruptedAttempt.payload.blocker_fingerprint,
            reason
          );
          saveState(current);
        }
        if (attemptCompleted) {
          assert(ordinal < current.claim_contract.caps.max_unsupported_attempts, 'CLOSEOUT_ATTEMPT_INCOMPLETE');
          return {
            status: 'CLOSE_DEFERRED',
            run_id: runId,
            blockers,
            decision: 'block',
            reason,
            closeout_attempt_ordinal: ordinal,
            replayed_delivery: true,
            compiled: attemptState.compiled_claim
          };
        }
        if (ordinal < current.claim_contract.caps.max_unsupported_attempts) {
          writeCheckpointArtifacts(runId, current, interruptedAttempt.payload.delivery_slot_ref);
          return {
            status: 'CLOSE_DEFERRED',
            run_id: runId,
            blockers,
            decision: 'block',
            reason,
            closeout_attempt_ordinal: ordinal,
            replayed_delivery: true,
            compiled: attemptState.compiled_claim
          };
        }
        assert(attemptState.compiled_claim?.input_digest === interruptedAttempt.payload?.input_digest, 'CLOSEOUT_ATTEMPT_STALE');
        const fingerprint = interruptedAttempt.payload.blocker_fingerprint;
        const envelope = {
          envelope_id: `closeout_${sha256(canonicalJson({ run_id: runId, fingerprint, ordinal })).slice(0, 24)}`,
          outcome: 'CLOSED_UNSUPPORTED',
          profile_id: attemptState.claim_contract.profile_id,
          requested_state: requested,
          supported_state: attemptState.compiled_claim.highest_supported_state,
          scope_ref: attemptState.claim_contract.objective_ref,
          eligible_evidence_frontier: interruptedAttempt.payload.eligible_evidence_frontier,
          material_control_frontier: interruptedAttempt.payload.material_control_frontier,
          input_digest: interruptedAttempt.payload.input_digest,
          claim_contract_ref: attemptState.claim_contract.claim_contract_ref,
          fold_version: CURRENT_FOLD_VERSION,
          blockers,
          next_verifier: nextVerifier,
          narrative: reason
        };
        const envelopeEvent = appendEventUnlocked(runId, current, {
          type: 'closeout_envelope_generated',
          origin: 'runtime_hook',
          payload: envelope,
          idempotencyKey: `closeout-envelope:${envelope.envelope_id}`
        });
        current.closeout_envelope = { ...envelopeEvent.payload, event_ref: `sha256:${envelopeEvent.event_hash}` };
        saveState(current);
        return finalizeRunSealUnlocked(runId, current, 'CLOSED_UNSUPPORTED', {
          claim_contract_ref: attemptState.claim_contract.claim_contract_ref,
          supported_state: attemptState.compiled_claim.highest_supported_state,
          requested_state: requested,
          closeout_envelope_ref: current.closeout_envelope.event_ref
        });
      }
      // A close-requested claim Stop that crashed after its checkpoint but before its durable attempt
      // has not finished the gate. Resume below without appending a second checkpoint; returning a
      // bare CLOSE_DEFERRED here would omit decision:block and let the parent stop through the gate.
      resumeCloseoutAfterCheckpoint = Boolean(
        current.close_requested && current.claim_contract && !attemptCompleted
      );
      if (!resumeCloseoutAfterCheckpoint) {
        // The Stop was observed. If the original delivery crashed after appending the turn_checkpoint
        // but before writeCheckpointArtifacts wrote the packet, no checkpoint_anchor follows it — finish
        // that interrupted packet now so every observed Stop has its verifiable checkpoint. If an anchor
        // already follows this checkpoint the packet is complete; do NOT re-anchor (that would fold later
        // activity into a fresh anchor for a repeated hook). Never re-seal or re-defer.
        const packetComplete = preEvents.some((event) => event.type === 'checkpoint_anchor' && event.seq > priorCheckpoint.seq);
        if (!packetComplete) writeCheckpointArtifacts(runId, current);
        // An anchor proves the packet was anchored, NOT that every derived artifact landed. Artifact
        // writes run continuation → handoff → index, so a crash in that tail leaves an anchored packet
        // whose capsule no successor can resolve — and the anchor is exactly what makes this branch
        // skip the repair. Reconcile the index from the capsule already on disk; it restates a fact
        // the packet holds, so it can never invent a link.
        else ensureStopArtifacts(runId, current);
        return { status: current.close_requested ? 'CLOSE_DEFERRED' : 'CHECKPOINTED', run_id: runId, replayed_delivery: true };
      }
    }
    if (!resumeCloseoutAfterCheckpoint) {
      appendEventUnlocked(runId, current, {
        type: 'turn_checkpoint',
        origin: 'runtime_hook',
        // The renderer version rides in this event for observability; the verification gate reads the
        // checkpoint_anchor event that writeCheckpointArtifacts appends (never the mutable anchor
        // file), mirroring how run_sealed pins the seal renderer.
        payload: { status: 'OPEN', receipt_renderer: ADAPTER_VERSION },
        idempotencyKey: checkpointKey
      });
    }
    saveState(current);
    if (!current.close_requested) {
      // A plain Stop is still a continuation boundary. Recompile an open contract before folding
      // it so material control added since the prior compile (notably a lease transfer) cannot be
      // published with a current ledger tip but stale compiler frontiers.
      if (current.claim_contract) {
        compileAndRecordUnlocked(runId, current);
        saveState(current);
      }
      writeCheckpointArtifacts(runId, current);
      return { status: 'CHECKPOINTED', run_id: runId };
    }
    if (current.claim_contract) {
      const gateId = current.claim_contract.declared_gate_ids[0];
      const compiled = compileAndRecordUnlocked(runId, current);
      const requestedSupported = compiled.state_results?.[current.claim_contract.requested_state]?.supported === true;
      const blockers = claimCloseoutBlockers(current, compiled);
      const fingerprint = claimCloseoutBlockerFingerprint(current, gateId, compiled);

      if (!requestedSupported || blockers.length) {
        const { events: attemptEvents } = parseLedger(runId);
        const attemptSequence = attemptEvents.filter((event) => event.type === 'closeout_attempted').length + 1;
        const latestAttempt = [...attemptEvents].reverse().find((event) => event.type === 'closeout_attempted');
        // Ordinals count only the maximal contiguous streak of one fingerprint: A-B-A is A1,B1,A1.
        const ordinal = closeoutAttemptStreakContinues(
          current,
          attemptEvents,
          latestAttempt,
          fingerprint,
          compiled.eligible_evidence_frontier
        )
          ? Number(latestAttempt.payload.ordinal || 0) + 1
          : 1;
        appendEventUnlocked(runId, current, {
          type: 'closeout_attempted',
          origin: 'runtime_hook',
          payload: {
            claim_contract_ref: current.claim_contract.claim_contract_ref,
            gate_id: gateId,
            blocker_fingerprint: fingerprint,
            ordinal,
            attempt_sequence: attemptSequence,
            delivery_slot_ref: contractedCloseoutDelivery
              ? stopDeliverySlotRef(deliveryKey, completedDeliveryAttempts)
              : undefined,
            input_digest: compiled.input_digest,
            eligible_evidence_frontier: compiled.eligible_evidence_frontier,
            material_control_frontier: compiled.material_control_frontier,
            blockers
          },
          idempotencyKey: `closeout-attempt:${current.claim_contract.contract_id}:${attemptSequence}`
        });
        const reason = `Lyhna ${claimSupportPosition(compiled, current.claim_contract)}. Missing or conflicting evidence: ${blockers.join(', ') || 'REQUESTED_STATE_UNSUPPORTED'}. Next verifier: ${compiled.next_verifier}.`;
        ensureClaimDiagnosticUnlocked(runId, current, compiled, fingerprint, reason);
        if (ordinal < current.claim_contract.caps.max_unsupported_attempts) {
          saveState(current);
          writeCheckpointArtifacts(
            runId,
            current,
            contractedCloseoutDelivery ? stopDeliverySlotRef(deliveryKey, completedDeliveryAttempts) : undefined
          );
          return {
            status: 'CLOSE_DEFERRED',
            run_id: runId,
            blockers,
            decision: 'block',
            reason,
            closeout_attempt_ordinal: ordinal,
            compiled
          };
        }

        const envelope = {
          envelope_id: `closeout_${sha256(canonicalJson({ run_id: runId, fingerprint, ordinal })).slice(0, 24)}`,
          outcome: 'CLOSED_UNSUPPORTED',
          profile_id: current.claim_contract.profile_id,
          requested_state: current.claim_contract.requested_state,
          supported_state: compiled.highest_supported_state,
          scope_ref: current.claim_contract.objective_ref,
          eligible_evidence_frontier: compiled.eligible_evidence_frontier,
          material_control_frontier: compiled.material_control_frontier,
          input_digest: compiled.input_digest,
          claim_contract_ref: current.claim_contract.claim_contract_ref,
          fold_version: CURRENT_FOLD_VERSION,
          blockers,
          next_verifier: compiled.next_verifier,
          narrative: reason
        };
        const envelopeEvent = appendEventUnlocked(runId, current, {
          type: 'closeout_envelope_generated',
          origin: 'runtime_hook',
          payload: envelope,
          idempotencyKey: `closeout-envelope:${envelope.envelope_id}`
        });
        current.closeout_envelope = { ...envelopeEvent.payload, event_ref: `sha256:${envelopeEvent.event_hash}` };
        saveState(current);
        return finalizeRunSealUnlocked(runId, current, 'CLOSED_UNSUPPORTED', {
          claim_contract_ref: current.claim_contract.claim_contract_ref,
          supported_state: compiled.highest_supported_state,
          requested_state: current.claim_contract.requested_state,
          closeout_envelope_ref: current.closeout_envelope.event_ref
        });
      }

      resolveClaimDiagnosticUnlocked(runId, current, compiled);
      const envelope = {
        envelope_id: `closeout_${sha256(canonicalJson({ run_id: runId, input_digest: compiled.input_digest })).slice(0, 24)}`,
        outcome: 'SUPPORTED',
        profile_id: current.claim_contract.profile_id,
        requested_state: current.claim_contract.requested_state,
        supported_state: compiled.highest_supported_state,
        scope_ref: current.claim_contract.objective_ref,
        eligible_evidence_frontier: compiled.eligible_evidence_frontier,
        material_control_frontier: compiled.material_control_frontier,
        input_digest: compiled.input_digest,
        claim_contract_ref: current.claim_contract.claim_contract_ref,
        fold_version: CURRENT_FOLD_VERSION,
        blockers: [],
        next_verifier: compiled.next_verifier,
        narrative: `Evidence supports ${compiled.highest_supported_state} for profile ${current.claim_contract.profile_id}.`
      };
      const envelopeEvent = appendEventUnlocked(runId, current, {
        type: 'closeout_envelope_generated',
        origin: 'runtime_hook',
        payload: envelope,
        idempotencyKey: `closeout-envelope:${envelope.envelope_id}`
      });
      current.closeout_envelope = { ...envelopeEvent.payload, event_ref: `sha256:${envelopeEvent.event_hash}` };
      saveState(current);
      return finalizeRunSealUnlocked(runId, current, 'SEALED', {
        claim_contract_ref: current.claim_contract.claim_contract_ref,
        supported_state: compiled.highest_supported_state,
        requested_state: current.claim_contract.requested_state,
        closeout_envelope_ref: current.closeout_envelope.event_ref
      });
    }
    const evaluations = Object.values(current.evaluations);
    const closingSnapshots = Object.values(current.pr_snapshots).filter((snapshot) => snapshot.status === 'CONSISTENT');
    const blockers = [];
    if (!closingSnapshots.length) blockers.push('PR_SNAPSHOT_REQUIRED');
    for (const snapshot of closingSnapshots) {
      const snapshotEvaluations = evaluations.filter((evaluation) => evaluation.snapshot_id === snapshot.id && evaluation.status !== 'STALE');
      if (!snapshotEvaluations.length) {
        blockers.push(`EVALUATION_${snapshot.id}_REQUIRED`);
        continue;
      }
      for (const evaluation of snapshotEvaluations) {
        if (!['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(evaluation.status)) blockers.push(`EVALUATION_${evaluation.id}_${evaluation.status}`);
        if (!evaluation.child_receipt_id) blockers.push(`CHILD_RECEIPT_${evaluation.id}_OPEN`);
        if (!evaluation.child_receipt_retrieved) blockers.push(`CHILD_RECEIPT_${evaluation.id}_NOT_RETRIEVED`);
      }
    }
    for (const child of Object.values(current.children || {})) {
      if (child.status !== 'STOP_OBSERVED' || !child.receipt_id) {
        blockers.push(`CHILD_${child.id}_OPEN`);
      }
    }
    if (blockers.length) {
      blockers.sort();
      // This Stop is newly observed (a replay returned above). A blocker set identical to the LATEST
      // close_deferred observation appends no new close_deferred; any changed set — including one that
      // recurs after an intervening different set (the prior-occurrence count keys it) — is a
      // semantically distinct observation and appends its own event, so the lifecycle face's latest
      // close_deferred is always the latest observation.
      const { events: parsedEvents } = parseLedger(runId);
      const priorDeferred = parsedEvents.filter((event) => event.type === 'close_deferred');
      const latestDeferred = priorDeferred.at(-1);
      if (!latestDeferred || canonicalJson(latestDeferred.payload.blockers) !== canonicalJson(blockers)) {
        appendEventUnlocked(runId, current, {
          type: 'close_deferred',
          origin: 'runtime_hook',
          payload: { blockers, receipt_renderer: ADAPTER_VERSION },
          idempotencyKey: `close-deferred:o${priorDeferred.length}:${sha256(canonicalJson(blockers))}`
        });
      }
      saveState(current);
      // The deferred close is this newly observed Stop's checkpoint — anchor it.
      writeCheckpointArtifacts(runId, current);
      return { status: 'CLOSE_DEFERRED', run_id: runId, blockers };
    }
    // Mutable projection fields are not proof that the receipt bytes still exist. Verify every
    // durable child receipt immediately before the legacy seal, matching the contracted closeout
    // path and preventing a run from sealing around a file altered after retrieval.
    verifyChildReceipts(current);
    appendEventUnlocked(runId, current, {
      type: 'run_sealed',
      origin: 'runtime_hook',
      // The renderer version lives in the hash-chained ledger, not only in the mutable
      // anchor file, so verification's renderer gate cannot be downgraded by editing the anchor.
      payload: { status: 'SEALED', receipt_renderer: ADAPTER_VERSION, continuation_fold_version: CURRENT_FOLD_VERSION },
      idempotencyKey: `seal:${runId}`
    });
    const { events, tip } = parseLedger(runId);
    stripLegacyChildReceiptPaths(current);
    current.sealed = true;
    current.terminal_status = 'SEALED';
    current.ledger_count = events.length;
    current.ledger_tip = tip;
    saveState(current);
    const receiptJson = renderReceiptJson(current, events);
    const receiptMarkdown = renderReceiptMarkdown(current, events);
    atomicWriteText(join(runDir(runId), 'receipt.json'), receiptJson);
    atomicWriteText(join(runDir(runId), 'RECEIPT.md'), receiptMarkdown);
    const capsule = writeContinuationArtifacts(runId, current, events);
    atomicWriteJson(capsuleIndexPath(capsule.capsule_ref), { run_id: runId, capsule_ref: capsule.capsule_ref });
    atomicWriteJson(anchorPath(runId), {
      run_id: runId,
      final_seq: current.ledger_count,
      final_hash: current.ledger_tip,
      state_hash: sha256(canonicalJson(current)),
      receipt_json_hash: sha256(receiptJson),
      receipt_markdown_hash: sha256(receiptMarkdown),
      receipt_renderer: ADAPTER_VERSION
    });
    // CZ-14 decision: a sealed packet carries exactly one anchor — remove the checkpoint anchor
    // written by earlier Stops. repairSeal tolerates both presence (interrupted seal) and absence.
    dropCheckpointAnchor(runId);
    return {
      status: 'SEALED',
      run_id: runId,
      receipt_path: join(runDir(runId), 'RECEIPT.md'),
      handoff_path: join(runDir(runId), 'HANDOFF.md'),
      continuation_path: join(runDir(runId), 'continuation.json'),
      capsule_ref: capsule.capsule_ref
    };
    });
  } catch (error) {
    if (claimBoundary && error && typeof error === 'object') error.lyhnaClaimBoundary = true;
    throw error;
  }
}

// CZ-14 seal-as-you-go. The ledger is the trust root for open packets: after the Stop's
// checkpoint/close_deferred event is appended, the rendered receipt's hashes are committed to a
// hash-chained checkpoint_anchor EVENT, and only then are the receipt files and the convenience
// checkpoint-anchor.json written. Editing the mutable anchor file or the receipt files can
// therefore never select a weaker verification path — verification reads the anchor event. The
// receipt covers events 1..covers_seq (everything before its own anchor event); the latest anchor
// overwrites the file, history lives in the ledger. Called only after the checkpoint/close_deferred
// event is appended and state saved, so the parsed ledger and the passed state agree.
function writeCheckpointArtifacts(runId, state, deliverySlotRef = undefined) {
  const { events, tip } = parseLedger(runId);
  // Nothing happened since the previous anchor (e.g. a redelivered Stop deduped its checkpoint
  // event): the ledger tip IS the anchor; re-anchoring would anchor the anchor. Idempotent no-op —
  // except that the index must still be reconciled. Artifact writes are ordered continuation →
  // handoff → index, so a crash between the capsule and its index leaves a packet whose capsule the
  // successor cannot resolve, and the replayed Stop would otherwise return here and never repair it.
  if (
    events.at(-1)?.type === 'checkpoint_anchor'
    && (!deliverySlotRef || events.at(-1).payload?.delivery_slot_ref === deliverySlotRef)
  ) {
    ensureStopArtifacts(runId, state);
    return;
  }
  // Recover the state prefix before hashing: on a replayed Stop whose original delivery crashed after
  // appending turn_checkpoint/close_deferred but before saveState, the cached state lags the ledger.
  // Those events do not mutate semantic state, so advancing ledger_count/ledger_tip (after asserting
  // the cache is a valid prefix) makes the hashed state match the ledger this anchor commits to —
  // otherwise the committed state hash would be for a shorter prefix and verifyRun would reject it.
  if (events.length > state.ledger_count) {
    const prefixTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1]?.event_hash;
    assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
    state.ledger_count = events.length;
    state.ledger_tip = tip;
  }
  const coversSeq = events.length;
  const receiptJson = renderReceiptJson(state, events);
  const receiptMarkdown = renderReceiptMarkdown(state, events);
  const stateHash = sha256(canonicalJson(state));
  const receiptJsonHash = sha256(receiptJson);
  const receiptMarkdownHash = sha256(receiptMarkdown);
  const anchorEvent = appendEventUnlocked(runId, state, {
    type: 'checkpoint_anchor',
    origin: 'runtime_hook',
    payload: {
      covers_seq: coversSeq,
      tip_hash: tip,
      state_hash: stateHash,
      receipt_json_hash: receiptJsonHash,
      receipt_markdown_hash: receiptMarkdownHash,
      receipt_renderer: ADAPTER_VERSION,
      // The fold generation, committed in the chain so the lineage checker can dispatch on it.
      // The capsule also declares it, but the capsule is unanchored — a forged packet could set
      // that copy to whichever reducer verifies. This one it cannot touch.
      continuation_fold_version: CURRENT_FOLD_VERSION,
      delivery_slot_ref: deliverySlotRef
    },
    idempotencyKey: `checkpoint-anchor:${coversSeq}`
  });
  saveState(state);
  atomicWriteText(join(runDir(runId), 'receipt.json'), receiptJson);
  atomicWriteText(join(runDir(runId), 'RECEIPT.md'), receiptMarkdown);
  // Every Stop refreshes the handoff, so a window that is abandoned rather than closed still leaves
  // a current continuation for the next one. This is the case that matters most in practice: the
  // human switches windows because the window got expensive, not because the work reached a close.
  //
  // Fold from the ledger AS IT NOW STANDS, including the anchor event just appended. `events` above
  // was parsed before that append while `state` has since advanced past it, and folding the two
  // together produced a capsule that could not be re-folded from the packet: the checker reads
  // state.json (post-anchor) and the full ledger (post-anchor), so a pre-anchor fold never matched
  // and `prior_continuation_refolds` failed on every open window.
  const { events: anchoredEvents } = parseLedger(runId);
  writeContinuationArtifacts(runId, state, anchoredEvents);
  atomicWriteJson(checkpointAnchorPath(runId), {
    run_id: runId,
    as_of_seq: coversSeq,
    anchor_event_seq: anchorEvent.seq,
    tip_hash: tip,
    state_hash: stateHash,
    receipt_json_hash: receiptJsonHash,
    receipt_markdown_hash: receiptMarkdownHash,
    receipt_renderer: ADAPTER_VERSION
  });
}

export function verifySealedRun(runId) {
  return withLock(lockPath(runId), () => repairSeal(runId));
}

function checkpointReceiptFilesMatch(runId, payload) {
  const jsonPath = join(runDir(runId), 'receipt.json');
  const markdownPath = join(runDir(runId), 'RECEIPT.md');
  return existsSync(jsonPath)
    && sha256(readFileSync(jsonPath, 'utf8')) === payload.receipt_json_hash
    && existsSync(markdownPath)
    && sha256(readFileSync(markdownPath, 'utf8')) === payload.receipt_markdown_hash;
}

// CZ-14 open-packet verification. An unsealed run with checkpoint anchors is a verifiable packet at
// its last checkpoint. The trust root is the hash-chained ledger: receipt hashes are read from the
// latest checkpoint_anchor EVENT, so editing the mutable checkpoint-anchor.json or the receipt files
// can never select a weaker path, and deleting the anchor file hides nothing. Verifies: the whole
// chain; state-cache/ledger consistency; that the on-disk receipt files are the exact bytes some
// committed anchor event covers — scanning newest-first so a torn write on a later checkpoint (anchor
// appended, crash before its file writes) reports structurally at the earlier intact packet, never as
// tamper, and absent receipt files (a torn/incomplete write, including the first checkpoint) report a
// structural CHECKPOINT_INCOMPLETE with whether the bytes remain reconstructable from the ledger;
// agreement of the convenience anchor file, when present, with the committed anchor event it names
// (tolerating a one-write lag, since that file is a cache, not a trust root); and, when the ledger
// has not advanced past the anchor event and the ledger pins the current renderer, that re-rendering
// reproduces the anchored bytes and state hash exactly.
function verifyOpenPacket(runId) {
  const state = loadState(runId);
  assert(!state.sealed, 'RUN_SEALED');
  const { events } = parseLedger(runId);
  // The state cache must be a consistent prefix view of the ledger — it may lag after a crash
  // (readLedger recovers that), but it must never contradict the chain.
  assert(
    Number.isInteger(state.ledger_count) && state.ledger_count >= 0 && state.ledger_count <= events.length,
    'LOCAL_CHAIN_BROKEN'
  );
  const cacheTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1].event_hash;
  assert(cacheTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  // Child receipts are sealed to their own files during the run and named by the state; an open
  // packet must hash-check them exactly as the sealed path does, so a corrupted or deleted child
  // artifact cannot hide behind an otherwise-valid parent checkpoint.
  verifyChildReceipts(state);
  const anchorEvents = events.filter((event) => event.type === 'checkpoint_anchor');
  if (!anchorEvents.length) {
    // Legacy / pre-CZ-14 open shape (or a run that never reached a Stop): structural, never a throw.
    return { status: 'OPEN_NO_CHECKPOINT', run_id: runId, event_count: events.length };
  }
  const verifiedPayload = (anchorEvent) => {
    const payload = anchorEvent.payload || {};
    assert(
      Number.isInteger(payload.covers_seq)
      && payload.covers_seq === anchorEvent.seq - 1
      && payload.covers_seq >= 1
      && events[payload.covers_seq - 1].event_hash === payload.tip_hash
      && typeof payload.state_hash === 'string'
      && typeof payload.receipt_json_hash === 'string'
      && typeof payload.receipt_markdown_hash === 'string',
      'LOCAL_CHAIN_BROKEN'
    );
    return payload;
  };
  // The checkpoint-anchor.json file is a convenience MIRROR of a checkpoint_anchor event, never a
  // trust root — every gating hash is read from the ledger, never from this file. It may legitimately
  // lag one write behind: writeCheckpointArtifacts renames both receipt files before rewriting this
  // file, so a crash in that window leaves the receipt files on the LATEST anchor while this file
  // still names the PRIOR one. Validate it against the anchor EVENT it names (stale-but-valid is
  // fine); a file naming no committed anchor, or disagreeing with the one it names, is an incoherent
  // on-disk cache and fails closed — including in the torn-write branch, so a corrupted cache is
  // never hidden by an incomplete write.
  const assertAnchorFileCoherent = () => {
    const anchorFilePath = checkpointAnchorPath(runId);
    if (!existsSync(anchorFilePath)) return;
    let anchorFile;
    // A present-but-malformed cache is local corruption — a structural LOCAL_CHAIN_BROKEN, never a
    // raw Node SyntaxError leaking out of the verifier.
    try {
      anchorFile = JSON.parse(readFileSync(anchorFilePath, 'utf8'));
    } catch {
      assert(false, 'LOCAL_CHAIN_BROKEN');
    }
    const named = anchorEvents.find((event) => event.seq === anchorFile.anchor_event_seq);
    assert(named, 'LOCAL_CHAIN_BROKEN');
    const namedPayload = verifiedPayload(named);
    assert(
      anchorFile.run_id === runId
      && anchorFile.as_of_seq === namedPayload.covers_seq
      && anchorFile.tip_hash === namedPayload.tip_hash
      && anchorFile.state_hash === namedPayload.state_hash
      && anchorFile.receipt_json_hash === namedPayload.receipt_json_hash
      && anchorFile.receipt_markdown_hash === namedPayload.receipt_markdown_hash,
      'LOCAL_CHAIN_BROKEN'
    );
  };
  const latest = anchorEvents.at(-1);
  const latestPayload = verifiedPayload(latest);
  // Which ledger-committed anchor do BOTH on-disk receipt files reproduce? Normally the latest. A
  // torn write on a LATER checkpoint (anchor event appended, crash before its file writes) leaves the
  // files holding an earlier anchor's packet — scan newest-first and report at that one; the next
  // Stop heals the split.
  const allPayloads = anchorEvents.map((event) => verifiedPayload(event));
  let matched = null;
  let matchedPayload = null;
  for (let index = anchorEvents.length - 1; index >= 0; index -= 1) {
    if (checkpointReceiptFilesMatch(runId, allPayloads[index])) {
      matched = anchorEvents[index];
      matchedPayload = allPayloads[index];
      break;
    }
  }
  if (!matched) {
    // No single committed anchor is reproduced by both files. This is a torn/incomplete write —
    // benign — UNLESS a present file's content is vouched for by no committed anchor at all, which is
    // tamper. A file is checked per-slot against every committed anchor's hash: absent slots are an
    // unwritten/torn write (the first checkpoint has no earlier packet to fall back to), a mixed
    // pair is a crash between the two atomic renames, and either way the ledger-pinned anchor plus
    // the current deterministic renderer can reconstruct the bytes. Torn writes report a structural
    // CHECKPOINT_INCOMPLETE, never tamper and never a raw filesystem error.
    const jsonHashes = new Set(allPayloads.map((payload) => payload.receipt_json_hash));
    const markdownHashes = new Set(allPayloads.map((payload) => payload.receipt_markdown_hash));
    const jsonPath = join(runDir(runId), 'receipt.json');
    const markdownPath = join(runDir(runId), 'RECEIPT.md');
    if (existsSync(jsonPath)) assert(jsonHashes.has(sha256(readFileSync(jsonPath, 'utf8'))), 'LOCAL_CHAIN_BROKEN');
    if (existsSync(markdownPath)) assert(markdownHashes.has(sha256(readFileSync(markdownPath, 'utf8'))), 'LOCAL_CHAIN_BROKEN');
    // A corrupted anchor cache must surface even in the incomplete-write case, not be hidden by it.
    assertAnchorFileCoherent();
    let reproducible = false;
    if (events.length === latest.seq && latestPayload.receipt_renderer === ADAPTER_VERSION) {
      const stateAtAnchor = { ...state, ledger_count: latestPayload.covers_seq, ledger_tip: latestPayload.tip_hash };
      assert(sha256(canonicalJson(stateAtAnchor)) === latestPayload.state_hash, 'LOCAL_CHAIN_BROKEN');
      const covered = events.slice(0, latestPayload.covers_seq);
      assert(sha256(renderReceiptJson(stateAtAnchor, covered)) === latestPayload.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(sha256(renderReceiptMarkdown(stateAtAnchor, covered)) === latestPayload.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
      reproducible = true;
    }
    return {
      status: 'CHECKPOINT_INCOMPLETE',
      run_id: runId,
      as_of_seq: latestPayload.covers_seq,
      anchor_event_seq: latest.seq,
      content_reproducible_from_ledger: reproducible
    };
  }
  assertAnchorFileCoherent();
  if (events.length === matched.seq) {
    // Ledger exactly at the anchor: the current state minus the anchor event itself must reproduce
    // the committed state hash, and the current renderer must reproduce the committed bytes.
    const stateAtAnchor = { ...state, ledger_count: matchedPayload.covers_seq, ledger_tip: matchedPayload.tip_hash };
    assert(sha256(canonicalJson(stateAtAnchor)) === matchedPayload.state_hash, 'LOCAL_CHAIN_BROKEN');
    if (matchedPayload.receipt_renderer === ADAPTER_VERSION) {
      const covered = events.slice(0, matchedPayload.covers_seq);
      assert(sha256(renderReceiptJson(stateAtAnchor, covered)) === matchedPayload.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(sha256(renderReceiptMarkdown(stateAtAnchor, covered)) === matchedPayload.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
    }
  }
  return {
    status: 'CHECKPOINT_VERIFIED',
    run_id: runId,
    as_of_seq: matchedPayload.covers_seq,
    anchor_event_seq: matched.seq,
    latest_anchor_event_seq: latest.seq,
    files_match_latest_anchor: matched === latest,
    ledger_advanced: events.length > latest.seq
  };
}

// Dispatching verify: sealed runs keep verifySealedRun semantics unchanged; unsealed runs verify their
// open packet (checkpoint anchor) or return the legacy structural result.
export function verifyRun(runId) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    // A reader calling verifyRun before any hook redelivery must not misclassify a durable-sealed
    // ledger as open: adopt a terminal run_sealed (the same source of truth checkpointOrSeal uses),
    // then route sealed runs to repairSeal.
    adoptTerminalLedgerSeal(runId, state);
    return state.sealed ? repairSeal(runId) : verifyOpenPacket(runId);
  });
}

// CZ-11: a syntactically plausible but unknown capability is a rejected claim, not silence.
// Record a value-free trace (error code only) so a reader can distinguish "never claimed"
// from "claimed and the recording failed". No statement text, no content.
export function recordRejectedClaim(capability) {
  try {
    const match = typeof capability === 'string' ? capability.match(CAPABILITY_SHAPE) : null;
    if (!match) return null;
    const kind = match[1];
    const capabilityRef = sha256(capability);
    const active = readJson(activePath(capability), null);
    const runId = active?.run_id || null;
    const mapped = runId ? readJson(statePath(runId), null) : null;
    if (runId && mapped && !mapped.sealed) {
      return withLock(lockPath(runId), () => {
        const current = loadState(runId);
        recoverClaimControlStateUnlocked(runId, current);
        if (current.sealed || current.parent_capability_hash !== capabilityRef) {
          return writeRejectedClaimMarker(capabilityRef, kind);
        }
        appendEventUnlocked(runId, current, {
          type: 'claim_rejected',
          origin: 'mcp_routed',
          payload: { code: 'UNKNOWN_CAPABILITY', capability_kind: kind },
          idempotencyKey: `claim-rejected:${capabilityRef}`
        });
        saveState(current);
        return { recorded: 'run', run_id: runId };
      });
    }
    return writeRejectedClaimMarker(capabilityRef, kind);
  } catch {
    return null;
  }
}

const REJECTED_CLAIM_LIMIT = 32;

function writeRejectedClaimMarker(capabilityRef, kind) {
  const markerDir = join(root(), 'claim-rejected');
  const fileName = `claim-${capabilityRef.slice(0, 16)}.json`;
  let existing = [];
  try { existing = readdirSync(markerDir); } catch { existing = []; }
  if (existing.length >= REJECTED_CLAIM_LIMIT && !existing.includes(fileName)) return null;
  // CZ-11: the marker carries error code + capability kind only. The ref lives in the filename,
  // not the content, so a reader cannot correlate the marker back to a capability value.
  atomicWriteJson(claimRejectedMarkerPath(capabilityRef), {
    code: 'UNKNOWN_CAPABILITY',
    capability_kind: kind
  });
  return { recorded: 'marker', ref: capabilityRef };
}

export function getRunForTesting(runId) {
  const events = readLedger(runId);
  return { state: loadState(runId), events, directory: runDir(runId) };
}
