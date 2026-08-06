import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  appendEvent,
  addPrSnapshot,
  beginEvaluation,
  beginRun,
  checkpointOrSeal,
  claimInlineAdvisory,
  claimEvaluation,
  declareClaimContract,
  evaluateClaimGate,
  getCapability,
  getRunForTesting,
  mintChild,
  mintSession,
  recordClaim,
  recordEvaluation,
  requestClaimProducer,
  requestClose,
  sealChildByAgent,
  verifySealedRun
} from '../src/store.mjs';
import { isolatedData } from './helpers.mjs';
import { sha256 } from '../src/util.mjs';
import { compileClaim, profileRequirementsHash, SOFTWARE_RELEASE_PROFILE, validateProfile } from '../src/claim-compiler.mjs';

const pluginRoot = join(import.meta.dirname, '..');

function contract(overrides = {}) {
  return {
    profile_id: 'software_release/v1',
    requested_state: 'LIVE_PROVEN',
    declared_gate_ids: ['closeout'],
    named_producers: [
      'software_release/local',
      'software_release/repository',
      'software_release/deployment',
      'software_release/canary'
    ],
    verifier_id: 'software_release/canary_verifier',
    caps: { max_unsupported_attempts: 3 },
    ...overrides
  };
}

function observe(runId, declared, requirementId, eventKind, origin, producerId, subjectBinding, suffix = requirementId, producerIdentity = null) {
  const identities = {
    'software_release/local': 'local_verifier',
    'software_release/repository': 'github_observer',
    'software_release/deployment': 'registered_deployment_probe',
    'software_release/canary': 'registered_canary_probe'
  };
  return appendEvent(runId, {
    type: 'evidence_observed',
    origin,
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: requirementId,
      event_kind: eventKind,
      producer_id: producerId,
      producer_identity: producerIdentity || identities[producerId],
      source_cursor: `cursor_${suffix}`,
      observed_at: '2026-08-05T12:00:00Z',
      subject_binding: subjectBinding
    },
    idempotencyKey: `fixture-evidence:${suffix}`
  });
}

function seedBuilt(runId, declared) {
  observe(runId, declared, 'source_identity', 'source_identity_observed', 'mock_or_test', 'software_release/local', { source_ref: 'sha256:source' });
  observe(runId, declared, 'checks_terminal', 'checks_terminal_observed', 'mock_or_test', 'software_release/local', { source_ref: 'sha256:source', checks_ref: 'sha256:checks' });
}

const REGISTERED_EVENT_TYPES = [
  'builder_claim',
  'checkpoint_anchor',
  'child_receipt_retrieved',
  'child_receipt_sealed',
  'child_started',
  'child_stop_observed',
  'claim_compiled',
  'claim_contract_declared',
  'claim_rejected',
  'close_deferred',
  'close_requested',
  'closeout_attempted',
  'closeout_envelope_generated',
  'continuation_lease_transferred',
  'diagnostic_emitted',
  'diagnostic_resolved',
  'evaluation_claimed',
  'evaluation_finding',
  'evaluation_requested',
  'evidence_observed',
  'gate_evaluated',
  'hook_permissionrequest',
  'hook_posttooluse',
  'hook_pretooluse',
  'hook_subagentstart',
  'hook_subagentstop',
  'hook_userpromptsubmit',
  'pr_refreshed',
  'pr_snapshot',
  'producer_requested',
  'producer_terminal',
  'run_begun',
  'run_sealed',
  'turn_checkpoint'
];

const REQUIREMENT_SUBJECTS = {
  source_identity: { source_ref: 'sha256:source' },
  checks_terminal: { source_ref: 'sha256:source', checks_ref: 'sha256:checks' },
  merge_identity: { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' },
  deployment_identity: { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' },
  configuration_present: { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' },
  registered_canary: { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' },
  terminal_canary_state: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
};

test('every registered event rejects unknown fields in both privacy modes before hashing', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  for (const privacyMode of ['verified_context', 'proof']) {
    const parent = mintSession({ sessionId: `compiler-closed-event-${privacyMode}`, cwd: process.cwd() });
    const run = beginRun(parent, { mode: 'full', objective: 'Exercise the closed event registry.', privacyMode });
    declareClaimContract(parent, contract());
    for (const type of REGISTERED_EVENT_TYPES) {
      const marker = `RAW_UNKNOWN_${privacyMode}_${type}`;
      assert.throws(
        () => appendEvent(run.id, {
          type,
          origin: 'runtime_hook',
          payload: { unregistered_full_output: marker },
          idempotencyKey: `closed-event-${privacyMode}-${type}`
        }),
        /UNREGISTERED_EVENT_FIELD/
      );
    }
  }
  const bytes = readTree(data).join('\n');
  assert.equal(bytes.includes('RAW_UNKNOWN_'), false);
});

test('every release requirement validates identity, origin, and exact subject shape in both privacy modes', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const origins = { local: 'runtime_hook', repository: 'github_observed', production: 'registered_probe' };
  for (const privacyMode of ['verified_context', 'proof']) {
    const parent = mintSession({ sessionId: `compiler-closed-evidence-${privacyMode}`, cwd: process.cwd() });
    const run = beginRun(parent, { mode: 'full', objective: 'Exercise evidence bindings.', privacyMode });
    const declared = declareClaimContract(parent, contract());
    for (const requirement of SOFTWARE_RELEASE_PROFILE.requirements) {
      const base = {
        contract_id: declared.contract_id,
        profile_requirements_hash: declared.profile_requirements_hash,
        requirement_id: requirement.requirement_id,
        event_kind: requirement.event_kind,
        producer_id: requirement.producer_id,
        producer_identity: SOFTWARE_RELEASE_PROFILE.producers[requirement.producer_id].expected_identity,
        source_cursor: `cursor-${privacyMode}-${requirement.requirement_id}`,
        observed_at: '2026-08-05T12:00:00Z',
        subject_binding: REQUIREMENT_SUBJECTS[requirement.requirement_id]
      };
      assert.throws(() => appendEvent(run.id, {
        type: 'evidence_observed', origin: origins[requirement.assurance_class],
        payload: { ...base, producer_identity: `RAW_WRONG_IDENTITY_${requirement.requirement_id}` },
        idempotencyKey: `wrong-identity-${privacyMode}-${requirement.requirement_id}`
      }), /INVALID_EVIDENCE_BINDING/);
      assert.throws(() => appendEvent(run.id, {
        type: 'evidence_observed', origin: 'agent_reported', payload: base,
        idempotencyKey: `wrong-origin-${privacyMode}-${requirement.requirement_id}`
      }), /INVALID_EVIDENCE_BINDING/);
      assert.throws(() => appendEvent(run.id, {
        type: 'evidence_observed', origin: origins[requirement.assurance_class],
        payload: { ...base, subject_binding: { ...base.subject_binding, unregistered_binding: `RAW_BINDING_${requirement.requirement_id}` } },
        idempotencyKey: `wrong-binding-${privacyMode}-${requirement.requirement_id}`
      }), /INVALID_EVIDENCE_BINDING/);
    }
    assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').highest_supported_state, null);
  }
  const bytes = readTree(data).join('\n');
  assert.equal(bytes.includes('RAW_WRONG_IDENTITY_'), false);
  assert.equal(bytes.includes('RAW_BINDING_'), false);
});

test('proof mode projects producer-terminal cursors and rejects unbound control values before hashing', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-proof-producer-terminal', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Project terminal producer control.', privacyMode: 'proof' });
  const declared = declareClaimContract(parent, contract());
  const rawCursor = 'RAW_TERMINAL_CURSOR_51E7';
  const terminal = appendEvent(run.id, {
    type: 'producer_terminal',
    origin: 'runtime_hook',
    payload: {
      contract_id: declared.contract_id,
      claim_contract_ref: declared.claim_contract_ref,
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      status: 'INVALID',
      source_cursor: rawCursor,
      observed_at: '2026-08-05T12:00:00Z',
      evidence_refs: []
    },
    idempotencyKey: 'proof-producer-terminal'
  });
  assert.equal(terminal.payload.source_cursor, `cursor_${sha256(rawCursor)}`);
  assert.throws(() => appendEvent(run.id, {
    type: 'producer_terminal',
    origin: 'runtime_hook',
    payload: {
      contract_id: declared.contract_id,
      producer_id: 'software_release/canary',
      producer_identity: 'RAW_TERMINAL_IDENTITY_9B2A',
      status: 'INVALID'
    },
    idempotencyKey: 'proof-producer-terminal-wrong-identity'
  }), /INVALID_PRODUCER_TERMINAL/);
  const rawStatus = 'RAW_TERMINAL_STATUS_SECRET_4A9E';
  assert.throws(() => appendEvent(run.id, {
    type: 'producer_terminal',
    origin: 'runtime_hook',
    payload: {
      contract_id: declared.contract_id,
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      status: rawStatus
    },
    idempotencyKey: 'proof-producer-terminal-wrong-status'
  }), /INVALID_PRODUCER_TERMINAL/);
  const bytes = readTree(data).join('\n');
  assert.equal(bytes.includes(rawCursor), false);
  assert.equal(bytes.includes('RAW_TERMINAL_IDENTITY_9B2A'), false);
  assert.equal(bytes.includes(rawStatus), false);
});

function runHook(input, env) {
  const result = spawnSync(process.execPath, [join(pluginRoot, 'hooks', 'capture.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function readTree(rootPath) {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const path = join(rootPath, entry.name);
    return entry.isDirectory() ? readTree(path) : [readFileSync(path, 'utf8')];
  });
}

test('the customer-clean release fixture compiles exactly BUILT and derived or mock production events cannot promote it', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-built-fixture', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Release the artifact.' });
  const declared = declareClaimContract(parent, contract());
  seedBuilt(run.id, declared);

  appendEvent(run.id, {
    type: 'claim_compiled',
    origin: 'runtime_hook',
    payload: { highest_supported_state: 'LIVE_PROVEN', input_digest: 'forged-derived' },
    idempotencyKey: 'forged-derived-live'
  });
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'mock_or_test', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' });
  observe(run.id, declared, 'configuration_present', 'configuration_presence_observed', 'mock_or_test', 'software_release/deployment', { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' });
  observe(run.id, declared, 'registered_canary', 'registered_canary_observed', 'mock_or_test', 'software_release/canary', { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' });
  observe(run.id, declared, 'terminal_canary_state', 'terminal_canary_state_observed', 'mock_or_test', 'software_release/canary', { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' });

  const result = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(result.highest_supported_state, 'BUILT');
  assert.deepEqual(result.maximal_supported_nodes, ['BUILT']);
  assert(result.missing.includes('merge_identity'));
  assert(result.missing.includes('deployment_identity'));
  assert.equal(result.contradictions.includes('INELIGIBLE_deployment_identity'), false);
  const advisory = claimInlineAdvisory(parent);
  assert.match(advisory, /supports BUILT, not requested LIVE_PROVEN/);
  assert.match(advisory, /software_release\/repository_verifier/);
  assert.equal(claimInlineAdvisory(parent), null, 'unchanged diagnostic is suppressed from the ledger-backed frontier');
  requestClose(parent, 'Close above the evidence ceiling.');
  checkpointOrSeal(parent, 'dedup-stop');
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'diagnostic_emitted').length, 1, 'Stop reuses the inline diagnostic for the same compiler frontier');
});

test('profiles reject empty nodes and cycles before any contract can use them', () => {
  const empty = structuredClone(SOFTWARE_RELEASE_PROFILE);
  empty.nodes.BUILT = { prerequisite_nodes: [], requirement_ids: [] };
  assert.throws(() => validateProfile(empty), /EMPTY_PROFILE_NODE/);

  const cyclic = structuredClone(SOFTWARE_RELEASE_PROFILE);
  cyclic.nodes.BUILT.prerequisite_nodes = ['LIVE_PROVEN'];
  assert.throws(() => validateProfile(cyclic), /CYCLIC_PROFILE/);

  const controlEvent = structuredClone(SOFTWARE_RELEASE_PROFILE);
  controlEvent.requirements[0].event_kind = 'producer_terminal';
  assert.throws(() => validateProfile(controlEvent), /INVALID_PROFILE_REQUIREMENT/);

  const badEdge = structuredClone(SOFTWARE_RELEASE_PROFILE);
  badEdge.identity_edges[0].right_field = 'not_registered';
  assert.throws(() => validateProfile(badEdge), /INVALID_PROFILE_IDENTITY_EDGE/);

  const diamond = structuredClone(SOFTWARE_RELEASE_PROFILE);
  diamond.nodes.BRANCH_A = { prerequisite_nodes: ['BUILT'], requirement_ids: ['merge_identity'] };
  diamond.nodes.BRANCH_B = { prerequisite_nodes: ['BUILT'], requirement_ids: ['deployment_identity'] };
  diamond.surface_projection = ['BUILT', 'BRANCH_A', 'BRANCH_B'];
  assert.throws(() => validateProfile(diamond), /AMBIGUOUS_SURFACE_PROJECTION/);
});

test('the compiler evaluates registered internal DAG nodes before projecting surface states', () => {
  const profile = structuredClone(SOFTWARE_RELEASE_PROFILE);
  profile.nodes.INTERNAL_CANARY = {
    prerequisite_nodes: ['DEPLOYED'],
    requirement_ids: ['registered_canary']
  };
  profile.nodes.LIVE_PROVEN = {
    prerequisite_nodes: ['INTERNAL_CANARY'],
    requirement_ids: ['terminal_canary_state']
  };
  validateProfile(profile);
  const profileHash = profileRequirementsHash(profile);
  const declared = {
    ...contract(),
    contract_id: 'contract_0123456789abcdef0123456789abcdef',
    objective_ref: null,
    profile_requirements_hash: profileHash
  };
  const subjects = {
    source_identity: { source_ref: 'sha256:source' },
    checks_terminal: { source_ref: 'sha256:source', checks_ref: 'sha256:checks' },
    merge_identity: { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' },
    deployment_identity: { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' },
    configuration_present: { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' },
    registered_canary: { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' },
    terminal_canary_state: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
  };
  const origins = { local: 'runtime_hook', repository: 'github_observed', production: 'registered_probe' };
  const events = profile.requirements.map((requirement, index) => ({
    seq: index + 1,
    type: 'evidence_observed',
    origin: origins[requirement.assurance_class],
    event_hash: sha256(`internal-node-${index}`),
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: profileHash,
      requirement_id: requirement.requirement_id,
      event_kind: requirement.event_kind,
      producer_id: requirement.producer_id,
      producer_identity: profile.producers[requirement.producer_id].expected_identity,
      source_cursor: `cursor-${index}`,
      observed_at: '2026-08-05T12:00:00Z',
      subject_binding: subjects[requirement.requirement_id]
    }
  }));
  const compiled = compileClaim({ profile, contract: declared, events });
  assert.equal(compiled.state_results.INTERNAL_CANARY.supported, true);
  assert.equal(compiled.highest_supported_state, 'LIVE_PROVEN');
});

test('only exact registered producer identities support production state and a fully supported run seals at LIVE_PROVEN', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-live-fixture', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Seal only after the release canary is terminal.' });
  const declared = declareClaimContract(parent, contract());
  seedBuilt(run.id, declared);
  observe(run.id, declared, 'merge_identity', 'merge_identity_observed', 'github_observed', 'software_release/repository', { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' });
  assert.throws(
    () => observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }, 'wrong-deployment-identity', 'unregistered_probe'),
    /INVALID_EVIDENCE_BINDING/
  );
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').highest_supported_state, 'MERGED');
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:other-merge', artifact_ref: 'sha256:artifact' }, 'wrong-deployment-subject');
  const mismatched = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(mismatched.highest_supported_state, 'MERGED');
  assert(mismatched.contradictions.includes('IDENTITY_MISMATCH_deployment_identity'));
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }, 'deployment-ok');
  observe(run.id, declared, 'configuration_present', 'configuration_presence_observed', 'registered_probe', 'software_release/deployment', { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' });
  observe(run.id, declared, 'registered_canary', 'registered_canary_observed', 'registered_probe', 'software_release/canary', { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' });
  observe(run.id, declared, 'terminal_canary_state', 'terminal_canary_state_observed', 'registered_probe', 'software_release/canary', { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' });
  const compiled = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(compiled.highest_supported_state, 'LIVE_PROVEN');
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:newer-wrong-merge', artifact_ref: 'sha256:artifact' }, 'newer-deployment-mismatch');
  const contradicted = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(contradicted.highest_supported_state, 'MERGED', 'newer mismatched identity cannot resurrect an older matching envelope');
  assert(contradicted.contradictions.includes('IDENTITY_MISMATCH_deployment_identity'));
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }, 'deployment-restored');
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').highest_supported_state, 'LIVE_PROVEN');
  observe(run.id, declared, 'source_identity', 'source_identity_observed', 'mock_or_test', 'software_release/local', { source_ref: 'sha256:new-source' }, 'new-source');
  const stale = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(stale.highest_supported_state, null, 'a newer source identity invalidates the older release chain');
  assert(stale.missing.includes('checks_terminal'));
  observe(run.id, declared, 'source_identity', 'source_identity_observed', 'mock_or_test', 'software_release/local', { source_ref: 'sha256:source' }, 'source-restored');
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').highest_supported_state, 'LIVE_PROVEN');
  requestClose(parent, 'Seal at the supported state.');
  const result = checkpointOrSeal(parent, 'supported-stop');
  assert.equal(result.status, 'SEALED');
  assert.equal(getRunForTesting(run.id).state.compiled_claim.highest_supported_state, 'LIVE_PROVEN');
});

test('undeclared producers are rejected while malformed time becomes a sanitized blocker', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-producer-time-eligibility', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Reject unbound or undated evidence.' });
  const declared = declareClaimContract(parent, contract({ named_producers: ['software_release/local', 'software_release/canary'] }));
  seedBuilt(run.id, declared);
  assert.throws(() => observe(run.id, declared, 'merge_identity', 'merge_identity_observed', 'github_observed', 'software_release/repository', { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' }), /INVALID_EVIDENCE_BINDING/);
  assert.throws(() => observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }), /INVALID_EVIDENCE_BINDING/);
  assert.throws(() => observe(run.id, declared, 'configuration_present', 'configuration_presence_observed', 'registered_probe', 'software_release/deployment', { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' }), /INVALID_EVIDENCE_BINDING/);
  observe(run.id, declared, 'registered_canary', 'registered_canary_observed', 'registered_probe', 'software_release/canary', { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' });
  appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor-malformed-time',
      observed_at: 'not-a-timestamp',
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'malformed-observation-time'
  });
  const compiled = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(compiled.highest_supported_state, 'BUILT');
  assert(compiled.missing.includes('merge_identity'), 'an undeclared producer cannot append evidence');
  assert(compiled.missing.includes('terminal_canary_state'), 'a malformed timestamp cannot satisfy evidence');
  assert.equal(compiled.currentness, 'CURRENTNESS_UNPROVEN');
});

test('missing or malformed time becomes a sanitized currentness blocker while wrong-kind evidence is rejected', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-currentness-gate', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Require witnessed currentness at closeout.' });
  const declared = declareClaimContract(parent, contract());
  seedBuilt(run.id, declared);
  observe(run.id, declared, 'merge_identity', 'merge_identity_observed', 'github_observed', 'software_release/repository', { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' });
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' });
  observe(run.id, declared, 'configuration_present', 'configuration_presence_observed', 'registered_probe', 'software_release/deployment', { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' });
  observe(run.id, declared, 'registered_canary', 'registered_canary_observed', 'registered_probe', 'software_release/canary', { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' });
  observe(run.id, declared, 'terminal_canary_state', 'terminal_canary_state_observed', 'registered_probe', 'software_release/canary', { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }, 'terminal-valid-old');
  const missingTime = appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor-terminal-missing-time',
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'terminal-missing-time'
  });
  assert.equal(missingTime.payload.observed_at, null);
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'CURRENTNESS_UNPROVEN');
  const malformedObservedAt = 'RAW_MALFORMED_TIME_3C91';
  const malformed = appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor-terminal-malformed-new',
      observed_at: malformedObservedAt,
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'terminal-malformed-new'
  });
  assert.equal(malformed.payload.observed_at, null);
  const unproven = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(unproven.highest_supported_state, 'LIVE_PROVEN', 'older valid evidence remains visible but cannot close');
  assert.equal(unproven.currentness, 'CURRENTNESS_UNPROVEN');
  const currentnessAdvisory = claimInlineAdvisory(parent);
  assert.match(currentnessAdvisory, /supports requested LIVE_PROVEN, but closeout is blocked/);
  assert.match(currentnessAdvisory, /CURRENTNESS_UNPROVEN/);
  requestClose(parent, 'Close only if currentness is witnessed.');
  const blocked = checkpointOrSeal(parent, 'currentness-stop-1');
  assert.equal(blocked.decision, 'block');
  assert(blocked.blockers.includes('CURRENTNESS_UNPROVEN'));

  assert.throws(() => appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'wrong_terminal_event_kind',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor-terminal-wrong-kind-newer',
      observed_at: '2026-08-05T12:01:00Z',
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'terminal-wrong-kind-newer'
  }), /INVALID_EVIDENCE_BINDING/);
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'CURRENTNESS_UNPROVEN');
  observe(run.id, declared, 'terminal_canary_state', 'terminal_canary_state_observed', 'registered_probe', 'software_release/canary', { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }, 'terminal-valid-new');
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'AS_WITNESSED');
  assert.equal(claimInlineAdvisory(parent), null, 'restored currentness resolves without repeating the warning');
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'diagnostic_resolved').length, 1);
  assert.equal(checkpointOrSeal(parent, 'currentness-stop-2').status, 'SEALED');
  assert.equal(readTree(data).join('\n').includes(malformedObservedAt), false);
});

test('a reused source cursor with conflicting witnessed times blocks closeout until a new cursor arrives', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-currentness-cursor-conflict', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Reject ambiguous source frontiers.' });
  const declared = declareClaimContract(parent, contract());
  seedBuilt(run.id, declared);
  const evidence = [
    ['merge_identity', 'merge_identity_observed', 'github_observed', 'software_release/repository', { source_ref: 'sha256:source', base_ref: 'sha256:main', merge_ref: 'sha256:merge' }],
    ['deployment_identity', 'deployment_identity_observed', 'registered_probe', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }],
    ['configuration_present', 'configuration_presence_observed', 'registered_probe', 'software_release/deployment', { artifact_ref: 'sha256:artifact', configuration_ref: 'sha256:config' }],
    ['registered_canary', 'registered_canary_observed', 'registered_probe', 'software_release/canary', { artifact_ref: 'sha256:artifact', canary_ref: 'sha256:canary' }],
    ['terminal_canary_state', 'terminal_canary_state_observed', 'registered_probe', 'software_release/canary', { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }]
  ];
  for (const args of evidence) observe(run.id, declared, ...args);
  appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor_terminal_canary_state',
      observed_at: '2026-08-05T12:01:00Z',
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'terminal-cursor-conflict'
  });
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'CURRENTNESS_UNPROVEN');
  requestClose(parent, 'Close only after an unambiguous source frontier.');
  assert(checkpointOrSeal(parent, 'cursor-conflict-stop').blockers.includes('CURRENTNESS_UNPROVEN'));
  appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'registered_probe',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'terminal_canary_state',
      event_kind: 'terminal_canary_state_observed',
      producer_id: 'software_release/canary',
      producer_identity: 'registered_canary_probe',
      source_cursor: 'cursor-terminal-new',
      observed_at: '2026-08-05T12:02:00Z',
      subject_binding: { canary_ref: 'sha256:canary', terminal_state_ref: 'sha256:terminal' }
    },
    idempotencyKey: 'terminal-cursor-new'
  });
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'AS_WITNESSED');
});

test('a later source cursor cannot move witnessed time backward and a newer time restores currentness', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-currentness-time-regression', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Reject regressed witnessed time.' });
  const declared = declareClaimContract(parent, contract({ requested_state: 'BUILT' }));
  seedBuilt(run.id, declared);
  const sourceObservation = (cursor, observedAt, key) => appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'mock_or_test',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'source_identity',
      event_kind: 'source_identity_observed',
      producer_id: 'software_release/local',
      producer_identity: 'local_verifier',
      source_cursor: cursor,
      observed_at: observedAt,
      subject_binding: { source_ref: 'sha256:source' }
    },
    idempotencyKey: key
  });
  sourceObservation('cursor-source-forward', '2026-08-05T12:05:00Z', 'source-forward');
  sourceObservation('cursor-source-regressed', '2026-08-05T12:01:00Z', 'source-regressed');
  const regressed = evaluateClaimGate(parent, declared.contract_id, 'closeout');
  assert.equal(regressed.highest_supported_state, 'BUILT');
  assert.equal(regressed.currentness, 'CURRENTNESS_UNPROVEN');
  assert.match(claimInlineAdvisory(parent), /supports requested BUILT, but closeout is blocked/);
  sourceObservation('cursor-source-restored', '2026-08-05T12:06:00Z', 'source-restored');
  assert.equal(evaluateClaimGate(parent, declared.contract_id, 'closeout').currentness, 'AS_WITNESSED');
});

test('unsupported closeout counts a contiguous fingerprint streak, seals honestly, and releases the session', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-closeout-fixture', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Close only with live proof.' });
  const declared = declareClaimContract(parent, contract());
  seedBuilt(run.id, declared);
  requestClose(parent, 'The agent says this works in production.');

  const a1 = checkpointOrSeal(parent, 'stop-a1');
  assert.equal(a1.decision, 'block');
  assert.equal(a1.closeout_attempt_ordinal, 1);
  requestClaimProducer(parent, declared.contract_id, 'software_release/canary');
  const b1 = checkpointOrSeal(parent, 'stop-b1');
  assert.equal(b1.closeout_attempt_ordinal, 1);
  appendEvent(run.id, {
    type: 'producer_terminal',
    origin: 'runtime_hook',
    payload: { contract_id: declared.contract_id, producer_id: 'software_release/canary', status: 'INVALID' },
    idempotencyKey: 'fixture-producer-terminal'
  });
  const aAgain = checkpointOrSeal(parent, 'stop-a-again');
  assert.equal(aAgain.closeout_attempt_ordinal, 1, 'A-B-A restarts the A streak instead of resuming it');
  observe(run.id, declared, 'deployment_identity', 'deployment_identity_observed', 'mock_or_test', 'software_release/deployment', { merge_ref: 'sha256:merge', artifact_ref: 'sha256:artifact' }, 'ineligible-noise-does-not-reset');
  assert.equal(getRunForTesting(run.id).state.sealed, false);
  assert.equal(checkpointOrSeal(parent, 'stop-a2').closeout_attempt_ordinal, 2, 'ineligible evidence does not reset the eligible frontier');
  const terminal = checkpointOrSeal(parent, 'stop-a3');
  assert.equal(terminal.status, 'CLOSED_UNSUPPORTED');
  const final = getRunForTesting(run.id);
  assert.equal(final.state.sealed, true);
  assert.equal(final.state.terminal_status, 'CLOSED_UNSUPPORTED');
  assert.equal(final.events.at(-1).type, 'run_sealed');
  assert.equal(final.events.at(-1).payload.status, 'CLOSED_UNSUPPORTED');
  assert.throws(() => appendEvent(run.id, { type: 'evidence_observed', origin: 'mock_or_test', payload: {}, idempotencyKey: 'post-seal' }), /RUN_SEALED/);
  assert.equal(verifySealedRun(run.id).status, 'ALREADY_SEALED');

  const fresh = beginRun(parent, { mode: 'full', objective: 'A new contract requires a new run.' });
  assert.notEqual(fresh.id, run.id);
  assert.equal(fresh.sealed, false);
  assert.equal(fresh.claim_contract, null);
});

test('separate Stop hook processes preserve attempt state and the third seals CLOSED_UNSUPPORTED', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const env = { ...process.env, LYHNA_CODEX_DATA: data };
  const sessionId = 'compiler-cross-process-stop';
  const session = runHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: process.cwd() }, env);
  const parent = session.hookSpecificOutput.additionalContext.match(/LYHNA_SESSION_CAPABILITY=([^\s.]+)/)[1];
  const run = beginRun(parent, { mode: 'full', objective: 'Cross-process closeout.' });
  declareClaimContract(parent, contract());
  requestClose(parent, 'Close now.');

  const first = runHook({ hook_event_name: 'Stop', session_id: sessionId, event_id: 'process-stop-1', turn_id: 'turn-1' }, env);
  const second = runHook({ hook_event_name: 'Stop', session_id: sessionId, event_id: 'process-stop-2', turn_id: 'turn-2' }, env);
  const third = runHook({ hook_event_name: 'Stop', session_id: sessionId, event_id: 'process-stop-3', turn_id: 'turn-3' }, env);
  assert.equal(first.decision, 'block');
  assert.equal(second.decision, 'block');
  assert.deepEqual(third, {});
  const attempts = getRunForTesting(run.id).events.filter((event) => event.type === 'closeout_attempted');
  assert.deepEqual(attempts.map((event) => event.payload.ordinal), [1, 2, 3]);
  assert.equal(getRunForTesting(run.id).state.terminal_status, 'CLOSED_UNSUPPORTED');
});

test('proof-mode v2 withholds objective, claim, diagnostic, and closeout prose before hashing', { concurrency: false }, (t) => {
  isolatedData(t);
  const objective = 'OBJECTIVE_RAW_DO_NOT_PERSIST_7F31';
  const statement = 'CLAIM_RAW_DO_NOT_PERSIST_4A62';
  const closeReason = 'CLOSE_RAW_DO_NOT_PERSIST_9B14';
  const parent = mintSession({ sessionId: 'compiler-proof-fixture', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective, privacyMode: 'proof' });
  const declared = declareClaimContract(parent, contract());
  const first = recordClaim(parent, statement, []);
  const second = recordClaim(parent, statement, []);
  assert.notEqual(first.payload.builder_claim_id, second.payload.builder_claim_id);
  assert.equal(first.payload.statement, undefined);
  assert.equal(first.payload.statement_ref, undefined);
  assert.equal(first.payload.text_withheld, true);
  requestClose(parent, closeReason);
  checkpointOrSeal(parent, 'proof-stop-1');
  checkpointOrSeal(parent, 'proof-stop-2');
  checkpointOrSeal(parent, 'proof-stop-3');

  const packet = getRunForTesting(run.id);
  const files = readTree(packet.directory).join('\n');
  for (const raw of [objective, statement, closeReason]) assert.equal(files.includes(raw), false, `withheld prose leaked: ${raw}`);
  assert.equal(packet.events.some((event) => JSON.stringify(event).includes(statement)), false);
  assert.equal(packet.events.find((event) => event.type === 'closeout_envelope_generated').payload.text_withheld, true);
  const capsule = JSON.parse(readFileSync(join(packet.directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.continuation_fold_version, 'v2');
  assert.equal(capsule.status, 'CLOSED_UNSUPPORTED');
  assert.equal(capsule.claim_compiler.contract.contract_id, declared.contract_id);
});

test('proof mode rejects prose-shaped scope refs and unregistered event shapes before hashing', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const rawContinuation = 'CONTINUATION_RAW_DO_NOT_PERSIST_5A11';
  const invalidParent = mintSession({ sessionId: 'compiler-proof-invalid-continuation', cwd: process.cwd() });
  assert.throws(
    () => beginRun(invalidParent, {
      mode: 'full', objective: 'Private continuation.', privacyMode: 'proof', continuesFrom: rawContinuation
    }),
    /INVALID_CAPSULE_REF/
  );
  const unresolvedParent = mintSession({ sessionId: 'compiler-proof-unresolved-continuation', cwd: process.cwd() });
  const unresolvedRef = 'f'.repeat(64);
  const unresolvedRun = beginRun(unresolvedParent, {
    mode: 'full', objective: 'Private unresolved continuation.', privacyMode: 'proof', continuesFrom: unresolvedRef
  });
  assert.deepEqual(unresolvedRun.inherits, {
    capsule_ref: unresolvedRef, run_id: null, state_hash: null, resolution: 'UNRESOLVED_LOCALLY'
  });
  const parent = mintSession({ sessionId: 'compiler-proof-shape', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Private objective.', privacyMode: 'proof' });
  assert.throws(
    () => declareClaimContract(parent, contract({ objective_ref: `objective_${sha256('customer secret merger launch plan')}` })),
    /OBJECTIVE_REF_NOT_ISSUED/
  );
  assert.throws(
    () => declareClaimContract(parent, contract({ contract_id: `contract_${sha256('caller chosen').slice(0, 32)}` })),
    /CONTRACT_ID_NOT_ISSUED/
  );
  const declared = declareClaimContract(parent, contract({ objective_ref: run.objective_ref }));
  assert.equal(declared.objective_ref, run.objective_ref);
  assert.throws(
    () => appendEvent(run.id, { type: 'future_text_event', origin: 'runtime_hook', payload: { objective: 'RAW_PROSE' }, idempotencyKey: 'future-text' }),
    /UNREGISTERED_EVENT_TYPE/
  );
  assert.throws(
    () => appendEvent(run.id, {
      type: 'hook_posttooluse',
      origin: 'runtime_hook',
      payload: { event: 'PostToolUse', unknown_text_field: 'RAW_PROSE_MARKER' },
      idempotencyKey: 'known-event-unknown-field'
    }),
    /UNREGISTERED_EVENT_FIELD/
  );
  assert.throws(
    () => appendEvent(run.id, {
      type: 'hook_posttooluse',
      origin: 'runtime_hook',
      payload: {
        event: 'PostToolUse', event_id: null, model: null, tool_name: null, cwd_ref: null,
        payload_ref: { sha256: 'a'.repeat(64), bytes: 1, nested_text: 'NESTED_HOOK_PROSE' },
        support: 'tool_returned', outcome: 'returned'
      },
      idempotencyKey: 'known-event-nested-field'
    }),
    /INVALID_EVENT_PAYLOAD/
  );
  assert.throws(
    () => appendEvent(run.id, {
      type: 'evidence_observed',
      origin: 'runtime_hook',
      payload: {
        contract_id: declared.contract_id,
        profile_requirements_hash: declared.profile_requirements_hash,
        requirement_id: 'source_identity',
        event_kind: 'source_identity_observed',
        producer_id: 'software_release/local',
        producer_identity: 'local_verifier',
        source_cursor: 'nested-proof-cursor',
        observed_at: '2026-08-05T12:00:00Z',
        subject_binding: { source_ref: { nested_text: 'NESTED_SUBJECT_PROSE' } }
      },
      idempotencyKey: 'known-evidence-nested-field'
    }),
    /INVALID_EVIDENCE_BINDING/
  );
  const rawCursor = 'CURSOR_RAW_DO_NOT_PERSIST_6C20';
  const rawSource = 'SUBJECT_RAW_DO_NOT_PERSIST_B157';
  const rawObservedAt = 'OBSERVED_AT_RAW_DO_NOT_PERSIST_9C42';
  const malformed = appendEvent(run.id, {
      type: 'evidence_observed',
      origin: 'runtime_hook',
      payload: {
        contract_id: declared.contract_id,
        profile_requirements_hash: declared.profile_requirements_hash,
        requirement_id: 'source_identity',
        event_kind: 'source_identity_observed',
        producer_id: 'software_release/local',
        producer_identity: 'local_verifier',
        source_cursor: rawCursor,
        observed_at: rawObservedAt,
        subject_binding: { source_ref: rawSource }
      },
      idempotencyKey: 'known-evidence-malformed-observed-at'
    });
  assert.equal(malformed.payload.observed_at, null);
  const projected = appendEvent(run.id, {
    type: 'evidence_observed',
    origin: 'runtime_hook',
    payload: {
      contract_id: declared.contract_id,
      profile_requirements_hash: declared.profile_requirements_hash,
      requirement_id: 'source_identity',
      event_kind: 'source_identity_observed',
      producer_id: 'software_release/local',
      producer_identity: 'local_verifier',
      source_cursor: rawCursor,
      observed_at: '2026-08-05T12:00:00Z',
      subject_binding: { source_ref: rawSource }
    },
    idempotencyKey: 'known-evidence-opaque-projection'
  });
  assert.equal(projected.payload.source_cursor, `cursor_${sha256(rawCursor)}`);
  assert.equal(projected.payload.subject_binding.source_ref, `sha256:${sha256(rawSource)}`);
  assert.doesNotThrow(() => evaluateClaimGate(parent, declared.contract_id, 'closeout'));
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'gate_evaluated').length, 1);
  const proofLedger = JSON.stringify(getRunForTesting(run.id).events);
  for (const marker of ['RAW_PROSE', 'NESTED_HOOK_PROSE', 'NESTED_SUBJECT_PROSE', rawCursor, rawSource, rawObservedAt]) assert.equal(proofLedger.includes(marker), false);
  assert.equal(readTree(data).join('\n').includes(rawContinuation), false);
});

test('proof-mode evaluator prose is withheld from state and child receipts, not only from the ledger', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'compiler-proof-evaluator';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Private review.', privacyMode: 'proof' });
  const head = 'a'.repeat(40);
  const snapshot = addPrSnapshot(parent, {
    id: 'proof_eval_snapshot', repository: 'Lyhna-ai/example', pr_number: 1,
    base_sha: 'b'.repeat(40), head_before: head, head_after: head, status: 'CONSISTENT',
    files: [], checks: [], reviews: [], review_comments: [], issue_comments: [], failures: []
  });
  const evaluation = beginEvaluation(parent, snapshot.id, { path: process.cwd(), head, clean: true, detached: true });
  const child = mintChild({ sessionId, agentId: 'proof-evaluator-child' });
  claimEvaluation(child, evaluation.id);
  const secret = 'EVALUATOR_RAW_DO_NOT_PERSIST_2D91';
  recordEvaluation(child, evaluation.id, secret, [], {
    head_before: head, head_after: head, clean_before: true, clean_after: true,
    detached_before: true, detached_after: true
  });
  sealChildByAgent({ sessionId, agentId: 'proof-evaluator-child' });
  const bytes = readTree(getRunForTesting(run.id).directory).join('\n');
  assert.equal(bytes.includes(secret), false);
  assert.equal(bytes.includes(sha256(secret)), false, 'proof artifacts retain no prose-derived finding hash');
});

test('an open v2 contract rotates onto the successor session without a second ledger or lost child route', { concurrency: false }, (t) => {
  isolatedData(t);
  const firstSession = 'compiler-window-one';
  const firstParent = mintSession({ sessionId: firstSession, cwd: process.cwd() });
  const run = beginRun(firstParent, { mode: 'full', objective: 'Continue this open contract.' });
  declareClaimContract(firstParent, contract());
  const childCapability = mintChild({ sessionId: firstSession, agentId: 'pending-child' });
  requestClose(firstParent, 'Keep the contract open until evidence arrives.');
  assert.equal(checkpointOrSeal(firstParent, 'window-one-stop').closeout_attempt_ordinal, 1);
  const capsuleRef = JSON.parse(readFileSync(join(getRunForTesting(run.id).directory, 'continuation.json'), 'utf8')).capsule_ref;

  const secondParent = mintSession({ sessionId: 'compiler-window-two', cwd: process.cwd() });
  const resumed = beginRun(secondParent, { mode: 'full', objective: 'Resume.', continuesFrom: capsuleRef });
  assert.equal(resumed.id, run.id, 'open continuation rotates the same run rather than forking it');
  assert.equal(resumed.claim_contract.contract_id, run.claim_contract_id);
  assert.throws(() => recordClaim(firstParent, 'Old lease must be revoked.', []), /NO_ACTIVE_RUN/);
  assert.throws(() => beginRun(firstParent, { mode: 'full', objective: 'Revoked predecessor cannot open another run.' }), /CAPABILITY_REVOKED/);
  assert.equal(getCapability(childCapability).parent_capability_hash, sha256(secondParent));
  const childReceipt = sealChildByAgent({ sessionId: firstSession, agentId: 'pending-child' });
  assert.equal(childReceipt.status, 'STOP_OBSERVED');
  assert.equal(checkpointOrSeal(secondParent, 'window-two-stop').closeout_attempt_ordinal, 2, 'attempt frontier survives the window boundary');
  assert.throws(() => declareClaimContract(secondParent, contract()), /CLAIM_CONTRACT_ALREADY_DECLARED/);
  const events = getRunForTesting(run.id).events;
  assert.equal(events.filter((event) => event.type === 'claim_contract_declared').length, 1);
  assert.equal(events.filter((event) => event.type === 'continuation_lease_transferred').length, 1);
});

test('a stale archived capsule cannot fork an open contracted run and the current face still transfers', { concurrency: false }, (t) => {
  isolatedData(t);
  const firstParent = mintSession({ sessionId: 'compiler-stale-open-contract-one', cwd: process.cwd() });
  const run = beginRun(firstParent, { mode: 'full', objective: 'Advance an open contract face.' });
  declareClaimContract(firstParent, contract());
  checkpointOrSeal(firstParent, 'stale-open-face-a');
  const packet = getRunForTesting(run.id);
  const refA = JSON.parse(readFileSync(join(packet.directory, 'continuation.json'), 'utf8')).capsule_ref;
  recordClaim(firstParent, 'Advance the open run after face A.', []);
  checkpointOrSeal(firstParent, 'stale-open-face-b');
  const refB = JSON.parse(readFileSync(join(packet.directory, 'continuation.json'), 'utf8')).capsule_ref;
  assert.notEqual(refA, refB);

  const secondParent = mintSession({ sessionId: 'compiler-stale-open-contract-two', cwd: process.cwd() });
  assert.throws(
    () => beginRun(secondParent, { mode: 'full', objective: 'Do not fork stale face A.', continuesFrom: refA }),
    /STALE_CONTINUATION/
  );
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'continuation_lease_transferred').length, 0);
  assert.equal(beginRun(firstParent, { mode: 'full', objective: 'The original lease remains active.' }).id, run.id);
  const transferred = beginRun(secondParent, { mode: 'full', objective: 'Transfer current face B.', continuesFrom: refB });
  assert.equal(transferred.id, run.id);
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'continuation_lease_transferred').length, 1);
});

test('an open v2 lease transfer fails closed when the mutable state cache was altered after its checkpoint', { concurrency: false }, (t) => {
  isolatedData(t);
  const firstParent = mintSession({ sessionId: 'compiler-tampered-window-one', cwd: process.cwd() });
  const run = beginRun(firstParent, { mode: 'full', objective: 'Checkpoint an open claim contract.' });
  declareClaimContract(firstParent, contract());
  checkpointOrSeal(firstParent, 'tampered-window-stop');
  const packet = getRunForTesting(run.id);
  const capsuleRef = JSON.parse(readFileSync(join(packet.directory, 'continuation.json'), 'utf8')).capsule_ref;
  const statePath = join(packet.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.claim_contract.requested_state = 'BUILT';
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const secondParent = mintSession({ sessionId: 'compiler-tampered-window-two', cwd: process.cwd() });
  assert.throws(
    () => beginRun(secondParent, { mode: 'full', objective: 'Do not inherit altered state.', continuesFrom: capsuleRef }),
    /LOCAL_CHAIN_BROKEN/
  );
  assert.equal(getRunForTesting(run.id).events.some((event) => event.type === 'continuation_lease_transferred'), false);
});

test('an interrupted contract declaration is reconstructed from the ledger and remains immutable', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-contract-recovery', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Recover contract declaration.' });
  declareClaimContract(parent, contract());
  const packet = getRunForTesting(run.id);
  const statePath = join(packet.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.claim_contract = null;
  state.claim_profile = null;
  state.compiled_claim = null;
  state.ledger_count = 1;
  state.ledger_tip = packet.events[0].event_hash;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const resumed = beginRun(parent, { mode: 'full', objective: 'Resume.' });
  assert.equal(resumed.claim_contract.contract_id, run.claim_contract_id);
  assert.throws(() => declareClaimContract(parent, contract({ requested_state: 'BUILT' })), /CLAIM_CONTRACT_ALREADY_DECLARED/);
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'claim_contract_declared').length, 1);
});

test('an interrupted unsupported seal recovers its honest terminal status instead of degrading to SEALED', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-unsupported-seal-recovery', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Recover unsupported seal.' });
  declareClaimContract(parent, contract());
  requestClose(parent, 'Close unsupported.');
  checkpointOrSeal(parent, 'unsupported-1');
  checkpointOrSeal(parent, 'unsupported-2');
  checkpointOrSeal(parent, 'unsupported-3');
  const packet = getRunForTesting(run.id);
  const statePath = join(packet.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const seal = packet.events.at(-1);
  state.sealed = false;
  state.terminal_status = null;
  state.ledger_count = seal.seq - 1;
  state.ledger_tip = seal.prev_hash;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  for (const name of ['seal-anchor.json', 'receipt.json', 'RECEIPT.md', 'continuation.json', 'HANDOFF.md']) rmSync(join(packet.directory, name), { force: true });

  const recovered = checkpointOrSeal(parent, 'unsupported-recovery');
  assert.equal(recovered.status, 'ALREADY_SEALED');
  const final = getRunForTesting(run.id);
  assert.equal(final.state.terminal_status, 'CLOSED_UNSUPPORTED');
  assert.equal(JSON.parse(readFileSync(join(packet.directory, 'receipt.json'), 'utf8')).status, 'CLOSED_UNSUPPORTED');
});

test('a replayed third unsupported Stop finishes sealing after a crash behind the envelope', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-envelope-crash-replay', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Seal the third unsupported attempt.' });
  declareClaimContract(parent, contract());
  requestClose(parent, 'Close unsupported after three attempts.');
  checkpointOrSeal(parent, 'envelope-crash-1');
  checkpointOrSeal(parent, 'envelope-crash-2');
  checkpointOrSeal(parent, 'envelope-crash-3');

  const packet = getRunForTesting(run.id);
  const envelope = packet.events.at(-2);
  assert.equal(envelope.type, 'closeout_envelope_generated');
  writeFileSync(join(packet.directory, 'events.jsonl'), `${packet.events.slice(0, -1).map((event) => JSON.stringify(event)).join('\n')}\n`);
  const state = JSON.parse(readFileSync(join(packet.directory, 'state.json'), 'utf8'));
  state.sealed = false;
  state.terminal_status = null;
  state.ledger_count = envelope.seq;
  state.ledger_tip = envelope.event_hash;
  writeFileSync(join(packet.directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  for (const name of ['seal-anchor.json', 'checkpoint-anchor.json', 'receipt.json', 'RECEIPT.md', 'continuation.json', 'HANDOFF.md']) {
    rmSync(join(packet.directory, name), { force: true });
  }

  const replayed = checkpointOrSeal(parent, 'envelope-crash-3');
  assert.equal(replayed.status, 'CLOSED_UNSUPPORTED');
  const final = getRunForTesting(run.id);
  assert.equal(final.state.sealed, true);
  assert.equal(final.events.filter((event) => event.type === 'closeout_attempted').length, 3);
  assert.equal(final.events.filter((event) => event.type === 'closeout_envelope_generated').length, 1);
  assert.equal(final.events.at(-1).type, 'run_sealed');
});

test('a replayed Stop resumes a durable closeout attempt without escaping or incrementing the cap', { concurrency: false }, (t) => {
  isolatedData(t);
  const exercise = (suffix, attemptCount) => {
    const parent = mintSession({ sessionId: `compiler-attempt-crash-${suffix}`, cwd: process.cwd() });
    const run = beginRun(parent, { mode: 'full', objective: 'Recover a durable closeout attempt.' });
    declareClaimContract(parent, contract());
    requestClose(parent, 'Close unsupported after bounded attempts.');
    for (let ordinal = 1; ordinal <= attemptCount; ordinal += 1) checkpointOrSeal(parent, `attempt-crash-${suffix}-${ordinal}`);
    const packet = getRunForTesting(run.id);
    const attempt = packet.events.filter((event) => event.type === 'closeout_attempted').at(-1);
    assert.equal(attempt.payload.ordinal, attemptCount);
    writeFileSync(join(packet.directory, 'events.jsonl'), `${packet.events.slice(0, attempt.seq).map((event) => JSON.stringify(event)).join('\n')}\n`);
    const state = JSON.parse(readFileSync(join(packet.directory, 'state.json'), 'utf8'));
    state.sealed = false;
    state.terminal_status = null;
    state.closeout_envelope = null;
    state.ledger_count = attempt.seq;
    state.ledger_tip = attempt.event_hash;
    writeFileSync(join(packet.directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    for (const name of ['seal-anchor.json', 'checkpoint-anchor.json', 'receipt.json', 'RECEIPT.md', 'continuation.json', 'HANDOFF.md']) {
      rmSync(join(packet.directory, name), { force: true });
    }
    return { parent, run, deliveryKey: `attempt-crash-${suffix}-${attemptCount}` };
  };

  const second = exercise('second', 2);
  const blocked = checkpointOrSeal(second.parent, second.deliveryKey);
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.closeout_attempt_ordinal, 2);
  assert.equal(getRunForTesting(second.run.id).events.filter((event) => event.type === 'closeout_attempted').length, 2);

  const third = exercise('third', 3);
  const sealed = checkpointOrSeal(third.parent, third.deliveryKey);
  assert.equal(sealed.status, 'CLOSED_UNSUPPORTED');
  const final = getRunForTesting(third.run.id);
  assert.equal(final.events.filter((event) => event.type === 'closeout_attempted').length, 3);
  assert.equal(final.events.filter((event) => event.type === 'closeout_envelope_generated').length, 1);
  assert.equal(final.events.filter((event) => event.type === 'run_sealed').length, 1);
  assert.equal(checkpointOrSeal(third.parent, third.deliveryKey).status, 'NO_ACTIVE_RUN');
});

test('a supported closeout envelope blocks contradictory evidence until crash replay seals it', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'compiler-supported-envelope-barrier', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Seal the supported build boundary.' });
  const declared = declareClaimContract(parent, contract({
    requested_state: 'BUILT',
    named_producers: ['software_release/local'],
    verifier_id: 'software_release/local_verifier'
  }));
  seedBuilt(run.id, declared);
  requestClose(parent, 'Seal supported BUILT evidence.');
  checkpointOrSeal(parent, 'supported-envelope-stop');

  const packet = getRunForTesting(run.id);
  const envelope = packet.events.at(-2);
  assert.equal(envelope.type, 'closeout_envelope_generated');
  writeFileSync(join(packet.directory, 'events.jsonl'), `${packet.events.slice(0, -1).map((event) => JSON.stringify(event)).join('\n')}\n`);
  const state = JSON.parse(readFileSync(join(packet.directory, 'state.json'), 'utf8'));
  state.sealed = false;
  state.terminal_status = null;
  state.ledger_count = envelope.seq;
  state.ledger_tip = envelope.event_hash;
  writeFileSync(join(packet.directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  for (const name of ['seal-anchor.json', 'receipt.json', 'RECEIPT.md', 'continuation.json', 'HANDOFF.md']) {
    rmSync(join(packet.directory, name), { force: true });
  }

  assert.throws(
    () => observe(run.id, declared, 'source_identity', 'source_identity_observed', 'runtime_hook', 'software_release/local', { source_ref: 'sha256:contradictory-source' }, 'post-envelope-contradiction'),
    /CLOSEOUT_ENVELOPE_PENDING_SEAL/
  );
  assert.equal(checkpointOrSeal(parent, 'supported-envelope-stop').status, 'SEALED');
  const final = getRunForTesting(run.id);
  assert.equal(final.events.filter((event) => event.type === 'closeout_envelope_generated').length, 1);
  assert.equal(final.events.at(-1).type, 'run_sealed');
});

test('a committed lease-transfer event completes idempotently after projection writes are interrupted', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const firstParent = mintSession({ sessionId: 'compiler-transfer-crash-one', cwd: process.cwd() });
  const run = beginRun(firstParent, { mode: 'full', objective: 'Transfer after checkpoint.' });
  declareClaimContract(firstParent, contract());
  const child = mintChild({ sessionId: 'compiler-transfer-crash-one', agentId: 'transfer-child' });
  checkpointOrSeal(firstParent, 'transfer-crash-checkpoint');
  const packet = getRunForTesting(run.id);
  const oldState = JSON.parse(readFileSync(join(packet.directory, 'state.json'), 'utf8'));
  const capsuleRef = JSON.parse(readFileSync(join(packet.directory, 'continuation.json'), 'utf8')).capsule_ref;
  const secondParent = mintSession({ sessionId: 'compiler-transfer-crash-two', cwd: process.cwd() });
  beginRun(secondParent, { mode: 'full', objective: 'Transfer.', continuesFrom: capsuleRef });

  writeFileSync(join(packet.directory, 'state.json'), `${JSON.stringify(oldState, null, 2)}\n`);
  const childPath = join(data, 'capabilities', `${sha256(child)}.json`);
  const childRecord = JSON.parse(readFileSync(childPath, 'utf8'));
  childRecord.parent_capability_hash = sha256(firstParent);
  writeFileSync(childPath, `${JSON.stringify(childRecord, null, 2)}\n`);
  rmSync(join(data, 'active', `${sha256(secondParent)}.json`), { force: true });
  writeFileSync(join(data, 'active', `${sha256(firstParent)}.json`), `${JSON.stringify({ run_id: run.id }, null, 2)}\n`);

  const predecessorPath = join(data, 'capabilities', `${sha256(firstParent)}.json`);
  const predecessorRecord = JSON.parse(readFileSync(predecessorPath, 'utf8'));
  delete predecessorRecord.revoked;
  writeFileSync(predecessorPath, `${JSON.stringify(predecessorRecord, null, 2)}\n`);
  assert.throws(
    () => beginRun(firstParent, { mode: 'full', objective: 'Crash recovery must not reattach the predecessor.' }),
    /CAPABILITY_REVOKED/
  );

  const replayed = beginRun(secondParent, { mode: 'full', objective: 'Replay transfer.', continuesFrom: capsuleRef });
  assert.equal(replayed.id, run.id);
  assert.equal(getCapability(child).parent_capability_hash, sha256(secondParent));
  assert.throws(() => recordClaim(firstParent, 'Revoked owner.', []), /CAPABILITY_RUN_MISMATCH|NO_ACTIVE_RUN/);
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'continuation_lease_transferred').length, 1);
});

test('a Stop integrity failure returns BLOCKED_TRANSPORT instead of allowing closeout to continue', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const env = { ...process.env, LYHNA_CODEX_DATA: data };
  const sessionId = 'compiler-stop-integrity';
  const session = runHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: process.cwd() }, env);
  const parent = session.hookSpecificOutput.additionalContext.match(/LYHNA_SESSION_CAPABILITY=([^\s.]+)/)[1];
  const run = beginRun(parent, { mode: 'full', objective: 'Fail closed on corrupt state.' });
  const packet = getRunForTesting(run.id);
  const statePath = join(packet.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.ledger_tip = 'f'.repeat(64);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = runHook({ hook_event_name: 'Stop', session_id: sessionId, event_id: 'corrupt-stop' }, env);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /^BLOCKED_TRANSPORT:/);
});
