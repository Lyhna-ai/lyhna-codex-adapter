import { ORIGINS, canonicalJson, sha256 } from './util.mjs';

const REGISTERED_EVIDENCE_EVENT_KINDS = new Set([
  'source_identity_observed',
  'checks_terminal_observed',
  'merge_identity_observed',
  'deployment_identity_observed',
  'configuration_presence_observed',
  'registered_canary_observed',
  'terminal_canary_state_observed'
]);

const CONTROL_TYPES = new Set([
  'claim_contract_declared',
  'producer_requested',
  'producer_terminal',
  'gate_sample_observed',
  'claim_superseded'
]);

const CONTRACT_KEYS = new Set([
  'contract_id',
  'profile_id',
  'requested_state',
  'declared_gate_ids',
  'named_producers',
  'objective_ref',
  'verifier_id',
  'caps'
]);

const CAPS_KEYS = new Set(['max_unsupported_attempts']);
const OPAQUE_CONTRACT = /^contract_[a-f0-9]{32}$/;
const OPAQUE_OBJECTIVE = /^objective_[a-f0-9]{64}$/;
const CANONICAL_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const SOFTWARE_RELEASE_STRUCTURAL = deepFreeze({
  schema: 'lyhna.claim-profile.v1',
  profile_id: 'software_release/v1',
  surface_projection: ['BUILT', 'MERGED', 'DEPLOYED', 'LIVE_PROVEN'],
  gate_ids: ['closeout'],
  verifier_ids: [
    'software_release/local_verifier',
    'software_release/repository_verifier',
    'software_release/deployment_verifier',
    'software_release/canary_verifier'
  ],
  producers: {
    'software_release/local': { expected_identity: 'local_verifier' },
    'software_release/repository': { expected_identity: 'github_observer' },
    'software_release/deployment': { expected_identity: 'registered_deployment_probe' },
    'software_release/canary': { expected_identity: 'registered_canary_probe' }
  },
  requirements: [
    {
      requirement_id: 'source_identity',
      event_kind: 'source_identity_observed',
      assurance_class: 'local',
      eligible_origins: ['mock_or_test', 'runtime_hook'],
      producer_id: 'software_release/local',
      subject_fields: ['source_ref'],
      verifier_id: 'software_release/local_verifier'
    },
    {
      requirement_id: 'checks_terminal',
      event_kind: 'checks_terminal_observed',
      assurance_class: 'local',
      eligible_origins: ['mock_or_test', 'runtime_hook'],
      producer_id: 'software_release/local',
      subject_fields: ['source_ref', 'checks_ref'],
      verifier_id: 'software_release/local_verifier'
    },
    {
      requirement_id: 'merge_identity',
      event_kind: 'merge_identity_observed',
      assurance_class: 'repository',
      eligible_origins: ['github_observed', 'mock_or_test'],
      producer_id: 'software_release/repository',
      subject_fields: ['source_ref', 'base_ref', 'merge_ref'],
      verifier_id: 'software_release/repository_verifier'
    },
    {
      requirement_id: 'deployment_identity',
      event_kind: 'deployment_identity_observed',
      assurance_class: 'production',
      eligible_origins: ['registered_probe'],
      producer_id: 'software_release/deployment',
      subject_fields: ['merge_ref', 'artifact_ref'],
      verifier_id: 'software_release/deployment_verifier'
    },
    {
      requirement_id: 'configuration_present',
      event_kind: 'configuration_presence_observed',
      assurance_class: 'production',
      eligible_origins: ['registered_probe'],
      producer_id: 'software_release/deployment',
      subject_fields: ['artifact_ref', 'configuration_ref'],
      verifier_id: 'software_release/deployment_verifier'
    },
    {
      requirement_id: 'registered_canary',
      event_kind: 'registered_canary_observed',
      assurance_class: 'production',
      eligible_origins: ['registered_probe'],
      producer_id: 'software_release/canary',
      subject_fields: ['artifact_ref', 'canary_ref'],
      verifier_id: 'software_release/canary_verifier'
    },
    {
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      assurance_class: 'production',
      eligible_origins: ['registered_probe'],
      producer_id: 'software_release/canary',
      subject_fields: ['canary_ref', 'terminal_state_ref'],
      verifier_id: 'software_release/canary_verifier'
    }
  ],
  identity_edges: [
    { left_requirement: 'source_identity', left_field: 'source_ref', right_requirement: 'checks_terminal', right_field: 'source_ref' },
    { left_requirement: 'source_identity', left_field: 'source_ref', right_requirement: 'merge_identity', right_field: 'source_ref' },
    { left_requirement: 'merge_identity', left_field: 'merge_ref', right_requirement: 'deployment_identity', right_field: 'merge_ref' },
    { left_requirement: 'deployment_identity', left_field: 'artifact_ref', right_requirement: 'configuration_present', right_field: 'artifact_ref' },
    { left_requirement: 'deployment_identity', left_field: 'artifact_ref', right_requirement: 'registered_canary', right_field: 'artifact_ref' },
    { left_requirement: 'registered_canary', left_field: 'canary_ref', right_requirement: 'terminal_canary_state', right_field: 'canary_ref' }
  ],
  nodes: {
    BUILT: { prerequisite_nodes: [], requirement_ids: ['source_identity', 'checks_terminal'] },
    MERGED: { prerequisite_nodes: ['BUILT'], requirement_ids: ['merge_identity'] },
    DEPLOYED: { prerequisite_nodes: ['MERGED'], requirement_ids: ['deployment_identity', 'configuration_present'] },
    LIVE_PROVEN: { prerequisite_nodes: ['DEPLOYED'], requirement_ids: ['registered_canary', 'terminal_canary_state'] }
  }
});

export const SOFTWARE_RELEASE_PROFILE = SOFTWARE_RELEASE_STRUCTURAL;

export function profileRequirementsHash(profile = SOFTWARE_RELEASE_PROFILE) {
  return sha256(canonicalJson(profile));
}

export function getClaimProfile(profileId) {
  if (profileId !== SOFTWARE_RELEASE_PROFILE.profile_id) {
    throw Object.assign(new Error('PROFILE_NOT_REGISTERED'), { code: 'PROFILE_NOT_REGISTERED' });
  }
  return SOFTWARE_RELEASE_PROFILE;
}

export function validateProfile(profile) {
  const projection = profile?.surface_projection;
  if (!Array.isArray(projection) || !projection.length || new Set(projection).size !== projection.length) {
    throw Object.assign(new Error('AMBIGUOUS_SURFACE_PROJECTION'), { code: 'AMBIGUOUS_SURFACE_PROJECTION' });
  }
  for (const state of projection) {
    if (!profile.nodes?.[state]) throw Object.assign(new Error('INVALID_PROFILE_NODE'), { code: 'INVALID_PROFILE_NODE' });
  }
  const requirements = new Map((profile.requirements || []).map((item) => [item.requirement_id, item]));
  if (requirements.size !== (profile.requirements || []).length) throw Object.assign(new Error('DUPLICATE_REQUIREMENT'), { code: 'DUPLICATE_REQUIREMENT' });
  for (const requirement of requirements.values()) {
    const producer = profile.producers?.[requirement.producer_id];
    if (!REGISTERED_EVIDENCE_EVENT_KINDS.has(requirement.event_kind)
      || !requirement.producer_id
      || !producer
      || typeof producer.expected_identity !== 'string'
      || !producer.expected_identity
      || !Array.isArray(requirement.eligible_origins)
      || !requirement.eligible_origins.length
      || requirement.eligible_origins.some((origin) => !ORIGINS.has(origin))) {
      throw Object.assign(new Error('INVALID_PROFILE_REQUIREMENT'), { code: 'INVALID_PROFILE_REQUIREMENT' });
    }
    if (requirement.assurance_class === 'production'
      && (canonicalJson(requirement.eligible_origins) !== canonicalJson(['registered_probe']))) {
      throw Object.assign(new Error('INVALID_PRODUCTION_REQUIREMENT'), { code: 'INVALID_PRODUCTION_REQUIREMENT' });
    }
  }
  for (const edge of profile.identity_edges || []) {
    const left = requirements.get(edge.left_requirement);
    const right = requirements.get(edge.right_requirement);
    if (!left
      || !right
      || !left.subject_fields.includes(edge.left_field)
      || !right.subject_fields.includes(edge.right_field)) {
      throw Object.assign(new Error('INVALID_PROFILE_IDENTITY_EDGE'), { code: 'INVALID_PROFILE_IDENTITY_EDGE' });
    }
  }
  for (const node of Object.values(profile.nodes)) {
    if (!(node.prerequisite_nodes || []).length && !(node.requirement_ids || []).length) {
      throw Object.assign(new Error('EMPTY_PROFILE_NODE'), { code: 'EMPTY_PROFILE_NODE' });
    }
    for (const prerequisite of node.prerequisite_nodes || []) {
      if (!profile.nodes[prerequisite]) throw Object.assign(new Error('INVALID_PROFILE_EDGE'), { code: 'INVALID_PROFILE_EDGE' });
    }
    for (const requirementId of node.requirement_ids || []) {
      if (!requirements.has(requirementId)) throw Object.assign(new Error('INVALID_PROFILE_REQUIREMENT_REF'), { code: 'INVALID_PROFILE_REQUIREMENT_REF' });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (state) => {
    if (visiting.has(state)) throw Object.assign(new Error('CYCLIC_PROFILE'), { code: 'CYCLIC_PROFILE' });
    if (visited.has(state)) return;
    visiting.add(state);
    for (const prerequisite of profile.nodes[state].prerequisite_nodes || []) visit(prerequisite);
    visiting.delete(state);
    visited.add(state);
  };
  for (const state of Object.keys(profile.nodes)) visit(state);
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (profile.nodes[from].prerequisite_nodes || []).some((item) => reaches(item, target, seen));
  };
  for (let index = 1; index < projection.length; index += 1) {
    for (let prior = 0; prior < index; prior += 1) {
      if (!reaches(projection[index], projection[prior])) {
        throw Object.assign(new Error('AMBIGUOUS_SURFACE_PROJECTION'), { code: 'AMBIGUOUS_SURFACE_PROJECTION' });
      }
    }
  }
  return profile;
}

export function validateClaimContract(raw, privacyMode) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('INVALID_CLAIM_CONTRACT'), { code: 'INVALID_CLAIM_CONTRACT' });
  const unknown = Object.keys(raw).find((key) => !CONTRACT_KEYS.has(key));
  if (unknown) throw Object.assign(new Error(`UNKNOWN_CONTRACT_FIELD: ${unknown}`), { code: 'INVALID_CLAIM_CONTRACT' });
  const profile = validateProfile(getClaimProfile(raw.profile_id));
  if (!OPAQUE_CONTRACT.test(String(raw.contract_id || ''))) throw Object.assign(new Error('INVALID_CONTRACT_ID'), { code: 'INVALID_CLAIM_CONTRACT' });
  if (raw.objective_ref !== undefined && raw.objective_ref !== null && !OPAQUE_OBJECTIVE.test(String(raw.objective_ref))) {
    throw Object.assign(new Error('INVALID_OBJECTIVE_REF'), { code: 'INVALID_CLAIM_CONTRACT' });
  }
  if (!profile.nodes[raw.requested_state]) throw Object.assign(new Error('INVALID_REQUESTED_STATE'), { code: 'INVALID_CLAIM_CONTRACT' });
  if (!Array.isArray(raw.declared_gate_ids) || raw.declared_gate_ids.some((item) => typeof item !== 'string')) throw Object.assign(new Error('INVALID_GATE_ID'), { code: 'INVALID_CLAIM_CONTRACT' });
  const gates = [...new Set(raw.declared_gate_ids)];
  if (!gates.length || gates.some((gate) => !profile.gate_ids.includes(gate))) throw Object.assign(new Error('INVALID_GATE_ID'), { code: 'INVALID_CLAIM_CONTRACT' });
  if (!Array.isArray(raw.named_producers) || raw.named_producers.some((item) => typeof item !== 'string')) throw Object.assign(new Error('UNREGISTERED_PRODUCER'), { code: 'INVALID_CLAIM_CONTRACT' });
  const producers = [...new Set(raw.named_producers)];
  if (producers.some((producer) => !profile.producers[producer])) throw Object.assign(new Error('UNREGISTERED_PRODUCER'), { code: 'INVALID_CLAIM_CONTRACT' });
  if (!profile.verifier_ids.includes(raw.verifier_id)) throw Object.assign(new Error('UNREGISTERED_VERIFIER'), { code: 'INVALID_CLAIM_CONTRACT' });
  const caps = raw.caps || { max_unsupported_attempts: 3 };
  if (!caps || typeof caps !== 'object' || Array.isArray(caps) || Object.keys(caps).some((key) => !CAPS_KEYS.has(key)) || caps.max_unsupported_attempts !== 3) {
    throw Object.assign(new Error('INVALID_CONTRACT_CAPS'), { code: 'INVALID_CLAIM_CONTRACT' });
  }
  return {
    contract: {
      contract_id: raw.contract_id,
      profile_id: profile.profile_id,
      profile_requirements_hash: profileRequirementsHash(profile),
      requested_state: raw.requested_state,
      declared_gate_ids: gates.sort(codepointCompare),
      named_producers: producers.sort(codepointCompare),
      objective_ref: raw.objective_ref ?? null,
      verifier_id: raw.verifier_id,
      caps: { max_unsupported_attempts: 3 },
      run_privacy_mode_ref: `privacy:${privacyMode}`
    },
    profile
  };
}

function eligibleEvidenceProjection(event) {
  return {
    seq: event.seq,
    ref: `sha256:${event.event_hash}`,
    origin: event.origin,
    event_kind: event.payload?.event_kind ?? null,
    requirement_id: event.payload?.requirement_id ?? null,
    producer_id: event.payload?.producer_id ?? null,
    producer_identity: event.payload?.producer_identity ?? null,
    source_cursor: event.payload?.source_cursor ?? null,
    observed_at: event.payload?.observed_at ?? null,
    subject_binding: event.payload?.subject_binding ?? null
  };
}

function evidenceMatches(requirement, event, contract, profile) {
  const payload = event.payload || {};
  if (event.type !== 'evidence_observed' || payload.contract_id !== contract.contract_id) return false;
  if (payload.profile_requirements_hash !== contract.profile_requirements_hash) return false;
  if (payload.requirement_id !== requirement.requirement_id || payload.event_kind !== requirement.event_kind) return false;
  const expectedIdentity = profile.producers[requirement.producer_id]?.expected_identity;
  if (!contract.named_producers.includes(requirement.producer_id)
    || !requirement.eligible_origins.includes(event.origin)
    || payload.producer_id !== requirement.producer_id
    || payload.producer_identity !== expectedIdentity) return false;
  if (requirement.assurance_class === 'production' && (event.origin !== 'registered_probe' || payload.producer_id !== requirement.producer_id)) return false;
  if (!payload.source_cursor || !isCanonicalObservedAt(payload.observed_at) || !payload.subject_binding || typeof payload.subject_binding !== 'object') return false;
  return requirement.subject_fields.every((field) => typeof payload.subject_binding[field] === 'string' && payload.subject_binding[field].length > 0);
}

function isCanonicalObservedAt(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_SECONDS.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return new Date(parsed).toISOString() === normalized;
}

function maximalSupported(profile, supported) {
  return [...supported].filter((state) => !Object.entries(profile.nodes).some(([candidate, node]) => (
    supported.has(candidate) && (node.prerequisite_nodes || []).includes(state)
  ))).sort(codepointCompare);
}

export function compileClaim({ profile, contract, events }) {
  validateProfile(profile);
  const requirements = new Map(profile.requirements.map((item) => [item.requirement_id, item]));
  const primary = events.filter((event) => event.type === 'evidence_observed');
  const eligiblePrimary = primary.filter((event) => {
    const requirement = requirements.get(event.payload?.requirement_id);
    return requirement ? evidenceMatches(requirement, event, contract, profile) : false;
  });
  const eligibleProjection = eligiblePrimary.map(eligibleEvidenceProjection).sort((a, b) => a.seq - b.seq);
  const controlProjection = events
    .filter((event) => CONTROL_TYPES.has(event.type))
    .map((event) => ({ seq: event.seq, type: event.type, ref: `sha256:${event.event_hash}`, payload: event.payload }))
    .sort((a, b) => a.seq - b.seq);
  const eligible_evidence_frontier = sha256(canonicalJson(eligibleProjection));
  const material_control_frontier = sha256(canonicalJson(controlProjection));

  const satisfied = new Map();
  const contradictions = [];
  for (const requirement of requirements.values()) {
    const candidates = primary.filter((event) => event.payload?.requirement_id === requirement.requirement_id && event.payload?.contract_id === contract.contract_id);
    const match = [...candidates].reverse().find((event) => evidenceMatches(requirement, event, contract, profile));
    satisfied.set(requirement.requirement_id, match || null);
  }
  for (const edge of profile.identity_edges || []) {
    const left = satisfied.get(edge.left_requirement);
    const right = satisfied.get(edge.right_requirement);
    if (!left || !right) continue;
    if (left.payload.subject_binding[edge.left_field] !== right.payload.subject_binding[edge.right_field]) {
      // A later eligible identity is the current witnessed fact. Never search backward for an older
      // matching envelope: that would erase the contradiction and resurrect stale evidence.
      satisfied.set(edge.right_requirement, null);
      contradictions.push(`IDENTITY_MISMATCH_${edge.right_requirement}`);
    }
  }

  const supported = new Set();
  const state_results = {};
  const evaluating = new Set();
  const evaluateNode = (state) => {
    if (state_results[state]) return state_results[state].supported;
    if (evaluating.has(state)) throw Object.assign(new Error('CYCLIC_PROFILE'), { code: 'CYCLIC_PROFILE' });
    evaluating.add(state);
    const node = profile.nodes[state];
    const missing = (node.requirement_ids || []).filter((id) => !satisfied.get(id));
    const missingPrerequisites = (node.prerequisite_nodes || []).filter((id) => !evaluateNode(id));
    const nodeSupported = missing.length === 0 && missingPrerequisites.length === 0;
    if (nodeSupported) supported.add(state);
    state_results[state] = {
      supported: nodeSupported,
      missing_requirement_ids: missing,
      missing_prerequisite_nodes: missingPrerequisites
    };
    evaluating.delete(state);
    return nodeSupported;
  };
  for (const state of Object.keys(profile.nodes).sort(codepointCompare)) evaluateNode(state);

  const highest = [...profile.surface_projection].reverse().find((state) => supported.has(state)) || null;
  const requestedRequirements = new Set();
  const collectRequirements = (state) => {
    for (const prerequisite of profile.nodes[state].prerequisite_nodes || []) collectRequirements(prerequisite);
    for (const requirementId of profile.nodes[state].requirement_ids || []) requestedRequirements.add(requirementId);
  };
  collectRequirements(contract.requested_state);
  const missing = profile.requirements
    .map((item) => item.requirement_id)
    .filter((requirementId) => requestedRequirements.has(requirementId) && !satisfied.get(requirementId));
  const producerRequests = events.filter((event) => event.type === 'producer_requested' && event.payload?.contract_id === contract.contract_id);
  const producerTerminals = new Set(events.filter((event) => event.type === 'producer_terminal' && event.payload?.contract_id === contract.contract_id).map((event) => event.payload?.producer_id));
  const pending_producers = [...new Set(producerRequests.map((event) => event.payload?.producer_id).filter((id) => id && !producerTerminals.has(id)))].sort(codepointCompare);
  const relevantEligible = eligiblePrimary;
  const latestBoundCurrentness = new Map();
  for (const event of primary) {
    const requirement = requirements.get(event.payload?.requirement_id);
    if (!requirement || event.payload?.contract_id !== contract.contract_id) continue;
    const expectedIdentity = profile.producers[requirement.producer_id]?.expected_identity;
    const boundProducer = contract.named_producers.includes(requirement.producer_id)
      && requirement.eligible_origins.includes(event.origin)
      && event.payload?.producer_id === requirement.producer_id
      && event.payload?.producer_identity === expectedIdentity;
    if (boundProducer) latestBoundCurrentness.set(requirement.requirement_id, event);
  }
  const malformedCurrentnessCandidate = [...latestBoundCurrentness.values()]
    .some((event) => !event.payload?.source_cursor || !isCanonicalObservedAt(event.payload?.observed_at));
  const currentness = relevantEligible.length > 0 && !malformedCurrentnessCandidate
    ? 'AS_WITNESSED'
    : 'CURRENTNESS_UNPROVEN';
  const firstMissing = missing.length ? requirements.get(missing[0]) : null;
  const input_digest = sha256(canonicalJson({
    profile_requirements_hash: contract.profile_requirements_hash,
    contract,
    eligible_evidence_frontier,
    material_control_frontier,
    currentness
  }));
  return {
    contract_id: contract.contract_id,
    profile_ref: contract.profile_requirements_hash,
    requested_state: contract.requested_state,
    highest_supported_state: highest,
    maximal_supported_nodes: maximalSupported(profile, supported),
    state_results,
    missing,
    pending_producers,
    contradictions: [...new Set(contradictions)].sort(codepointCompare),
    currentness,
    next_verifier: firstMissing?.verifier_id || contract.verifier_id,
    eligible_evidence_frontier,
    material_control_frontier,
    input_digest
  };
}

export function blockerFingerprint(contract, gateId, compiled) {
  return sha256(canonicalJson({
    contract_id: contract.contract_id,
    gate_id: gateId,
    requested_state: contract.requested_state,
    missing: compiled.missing,
    pending_producers: compiled.pending_producers,
    contradictions: compiled.contradictions,
    currentness: compiled.currentness,
    eligible_evidence_frontier: compiled.eligible_evidence_frontier
  }));
}
