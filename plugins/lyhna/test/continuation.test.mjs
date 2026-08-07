import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  addPrSnapshot,
  beginEvaluation,
  beginRun,
  checkpointOrSeal,
  claimEvaluation,
  getRunForTesting,
  mintChild,
  mintSession,
  readSealedReceipt,
  recordClaim,
  verifySealedRun,
  recordEvaluation,
  requestClose,
  sealChildByAgent
} from '../src/store.mjs';
import {
  buildContinuation,
  deriveCapsuleRef,
  deriveStateHash,
  foldCandidatesForRenderer,
  labelClaims
} from '../src/continuation.mjs';
import { renderHandoffMarkdown } from '../src/handoff.mjs';
import { renderLineageMarkdown, verifyLineage, verifyLedgerChain } from '../src/lineage.mjs';
import { canonicalJson, sha256 } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

/** The closeout ceremony a full run requires before it may seal. */
function evaluateAndRetrieve(sessionId, parent, snapshot, agentId) {
  addPrSnapshot(parent, snapshot);
  const evaluation = beginEvaluation(
    parent,
    snapshot.id,
    { head: snapshot.head_after, clean: true, detached: true, path: `fixture-${snapshot.id}` },
    'initial'
  );
  const child = mintChild({ sessionId, agentId });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, `Finding for ${snapshot.id}.`, [], {
    head_before: snapshot.head_after,
    head_after: snapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const receipt = sealChildByAgent({ sessionId, agentId });
  readSealedReceipt(parent, receipt.id);
}

/** Drive one window from begin to seal, returning its packet directory and sealed capsule. */
function runWindow({ sessionId, objective, continuesFrom, privacyMode, claims = [] }) {
  const parent = mintSession({ sessionId });
  const run = beginRun(parent, { mode: 'full', objective, continuesFrom, privacyMode });
  for (const claim of claims) recordClaim(parent, claim.statement, claim.evidence_refs || []);
  evaluateAndRetrieve(sessionId, parent, stableSnapshot, `${sessionId}-evaluator`);
  requestClose(parent, 'Window complete.');
  const deliveryKey = privacyMode === 'proof'
    ? `id_${sha256(`${sessionId}-stop`)}`
    : `${sessionId}-stop`;
  const sealed = checkpointOrSeal(parent, deliveryKey);
  assert.equal(sealed.status, 'SEALED');
  return { parent, run, sealed, directory: getRunForTesting(run.id).directory };
}

/** Rewrite a fixture ledger while preserving a valid hash chain. Returns the rewritten events. */
function rechainLedger(directory, mutate) {
  const ledgerPath = join(directory, 'events.jsonl');
  const events = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let previous = '0'.repeat(64);
  for (const event of events) {
    mutate(event);
    event.prev_hash = previous;
    const { event_hash: _drop, ...rest } = event;
    event.event_hash = sha256(canonicalJson(rest));
    previous = event.event_hash;
  }
  writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return events;
}

/**
 * Recast a current fixture as a packet emitted by a named historical renderer. The historical
 * continuation is then written from that renderer's preserved fold, while the successor's chained
 * inheritance commitment is updated to name those exact bytes.
 */
function recastHistoricalPacket(prior, current, renderer, foldVersion) {
  const priorEvents = rechainLedger(prior.directory, (event) => {
    if (event.payload?.receipt_renderer) event.payload.receipt_renderer = renderer;
    if (event.payload?.continuation_fold_version) delete event.payload.continuation_fold_version;
    if (renderer === '0.1.28' && event.type === 'builder_claim') delete event.payload.statement_text;
  });
  const priorStatePath = join(prior.directory, 'state.json');
  const priorState = JSON.parse(readFileSync(priorStatePath, 'utf8'));
  priorState.ledger_count = priorEvents.length;
  priorState.ledger_tip = priorEvents.at(-1).event_hash;
  writeFileSync(priorStatePath, canonicalJson(priorState, true));

  const historical = buildContinuation(priorState, priorEvents, foldVersion);
  writeFileSync(join(prior.directory, 'continuation.json'), canonicalJson(historical, true));

  rechainLedger(current.directory, (event) => {
    if (event.type !== 'run_begun') return;
    event.payload.inherits.capsule_ref = historical.capsule_ref;
    event.payload.inherits.state_hash = historical.state_hash;
  });
  return historical;
}

test('the continuation capsule is a deterministic fold of the ledger', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({ sessionId: 'w1', objective: 'Build the thing.' });
  const { state, events } = getRunForTesting(run.id);

  const first = buildContinuation(state, events);
  const second = buildContinuation(state, events);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.capsule_ref, deriveCapsuleRef(first));
  // The published file is the same fold, not a separately authored document.
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(published.capsule_ref, first.capsule_ref);
});

test('claims are labeled against witnessed evidence, not accepted as narration', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'claims' });
  const run = beginRun(parent, { mode: 'full', objective: 'Check claims.' });
  // The witnessed event to cite is run_begun (origin mcp_routed) — something the witness observed,
  // not something the agent asserted. An earlier revision of this test cited another recordClaim
  // here and asserted SUPPORTED, which encoded the very laundering the test is named for.
  const witnessed = getRunForTesting(run.id).events.find((event) => event.type === 'run_begun');
  const narration = recordClaim(parent, 'First observable step completed.', []);

  recordClaim(parent, 'Backed by a real event in this run.', [`sha256:${witnessed.event_hash}`]);
  recordClaim(parent, 'Backed by something this run never saw.', [`sha256:${'e'.repeat(64)}`]);

  const { events } = getRunForTesting(run.id);
  const labeled = labelClaims(events);
  const bySupport = Object.fromEntries(labeled.map((claim) => [claim.support, claim.statement]));

  assert.equal(labeled.length, 3);
  assert.ok(bySupport.UNSUPPORTED, 'a claim citing no evidence is UNSUPPORTED');
  assert.ok(
    bySupport.REFERENCES_RESOLVE,
    'a claim citing a witnessed event is REFERENCES_RESOLVE — the reference resolves, which is not the same as support'
  );
  assert.equal(bySupport.SUPPORTED, undefined, 'the current fold never issues SUPPORTED');
  assert.ok(bySupport.UNRESOLVED_EVIDENCE, 'a claim citing an unknown ref is UNRESOLVED_EVIDENCE, not UNSUPPORTED');

  // The laundering path itself: an agent's own assertion is not evidence for another assertion.
  // Citing narration resolves perfectly well and is still worth nothing, so it lands on
  // UNSUPPORTED — not UNRESOLVED_EVIDENCE, which would wrongly say the reference did not resolve.
  recordClaim(parent, 'I deployed production.', [`sha256:${narration.event_hash}`]);
  const laundered = labelClaims(getRunForTesting(run.id).events).at(-1);
  assert.equal(laundered.support, 'UNSUPPORTED', 'a claim citing another claim must never be SUPPORTED');
  assert.deepEqual(laundered.unresolved_refs, [], 'the cited claim does resolve — it is simply not evidence');
});

test('narration cited as evidence never reaches the settled section', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'launder' });
  const run = beginRun(parent, { mode: 'full', objective: 'Deploy something.' });

  // Two identical claims. The only difference is that the second cites the first. If a claim can
  // be its own evidence, the second renders SUPPORTED and is promoted into `settled` — the section
  // a successor window is told it may rely on without redoing the work. SPEC is explicit that
  // settled is never agent narration.
  const first = recordClaim(parent, 'I deployed production.', []);
  recordClaim(parent, 'I deployed production.', [`sha256:${first.event_hash}`]);

  const { state, events } = getRunForTesting(run.id);
  const claims = labelClaims(events);
  assert.deepEqual(
    claims.map((claim) => claim.support),
    ['UNSUPPORTED', 'UNSUPPORTED'],
    'citing narration must not upgrade an identical claim'
  );

  const capsule = buildContinuation(state, events);
  const settledText = JSON.stringify(capsule.settled);
  assert.doesNotMatch(settledText, /deployed production/, 'narration must never be promoted to settled');
});

test('an abandoned window hands off a continuation that actually verifies', (t) => {
  isolatedData(t);
  // The open-to-open path: the window got expensive and was never closed, which is the exact case
  // the checkpoint handoff exists to serve. Sealed lineage and open handoff rendering were each
  // covered before; the path connecting them was not.
  const first = mintSession({ sessionId: 'open-1' });
  const firstRun = beginRun(first, { mode: 'full', objective: 'Expensive window, never closed.' });
  recordClaim(first, 'Some work happened.', []);
  const stop = checkpointOrSeal(first, 'open-1-stop');
  assert.equal(stop.status, 'CHECKPOINTED', 'no close was requested, so this must not seal');

  const firstDir = getRunForTesting(firstRun.id).directory;
  const capsule = JSON.parse(readFileSync(join(firstDir, 'continuation.json'), 'utf8'));
  assert.equal(capsule.status, 'OPEN');

  const second = mintSession({ sessionId: 'open-2' });
  const secondRun = beginRun(second, {
    mode: 'full',
    objective: 'Successor window.',
    continuesFrom: capsule.capsule_ref
  });
  // An OPEN capsule must be resolvable, or the successor commits a null state hash it can never match.
  assert.equal(
    getRunForTesting(secondRun.id).state.inherits.resolution,
    'RESOLVED_LOCAL_PACKET',
    'an open capsule must be indexed, not left UNRESOLVED_LOCALLY'
  );
  checkpointOrSeal(second, 'open-2-stop');

  const report = verifyLineage(firstDir, getRunForTesting(secondRun.id).directory);
  assert.deepEqual(report.checks.map((item) => item.name), LINEAGE_CHECKS);
  assert.ok(
    report.ok,
    `open-to-open must verify:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`
  );
});

test('a crash between the capsule and its index is repaired by the replayed Stop', (t) => {
  const root = isolatedData(t);
  const parent = mintSession({ sessionId: 'crash-index' });
  const run = beginRun(parent, { mode: 'full', objective: 'Crashes mid artifact write.' });
  recordClaim(parent, 'Some work happened.', []);
  checkpointOrSeal(parent, 'crash-index-stop');

  // Artifacts are written continuation -> handoff -> index. Model a crash in that tail: the capsule
  // persisted, its index entry did not. The anchor event is already in the ledger, so the replayed
  // Stop considers the packet complete and would never revisit it.
  const indexDir = join(root, 'capsule-index');
  const runDirectory = getRunForTesting(run.id).directory;
  rmSync(indexDir, { recursive: true, force: true });

  checkpointOrSeal(parent, 'crash-index-stop');
  assert.ok(existsSync(indexDir), 'the replayed Stop must reconcile the missing index');

  // The wider crash window: the anchor landed but NOTHING after it did. The anchor is exactly what
  // makes the replay declare the packet complete, so without explicit repair these files stay
  // missing forever and the SPEC promise — every observed Stop leaves a verifiable handoff — fails.
  const intactCapsule = readFileSync(join(runDirectory, 'continuation.json'), 'utf8');
  rmSync(join(runDirectory, 'continuation.json'));
  rmSync(join(runDirectory, 'HANDOFF.md'));
  rmSync(indexDir, { recursive: true, force: true });

  checkpointOrSeal(parent, 'crash-index-stop');
  assert.ok(existsSync(join(runDirectory, 'continuation.json')), 'the replayed Stop must restore the capsule');
  assert.ok(existsSync(join(runDirectory, 'HANDOFF.md')), 'the replayed Stop must restore the handoff');
  assert.ok(existsSync(indexDir), 'and the index with them');
  assert.equal(
    readFileSync(join(runDirectory, 'continuation.json'), 'utf8'),
    intactCapsule,
    'the restored capsule is byte-identical — a repair is a re-fold, never new content'
  );

  const capsule = JSON.parse(readFileSync(join(getRunForTesting(run.id).directory, 'continuation.json'), 'utf8'));
  const next = mintSession({ sessionId: 'crash-index-next' });
  const successor = beginRun(next, {
    mode: 'full',
    objective: 'Successor.',
    continuesFrom: capsule.capsule_ref
  });
  assert.equal(
    getRunForTesting(successor.id).state.inherits.resolution,
    'RESOLVED_LOCAL_PACKET',
    'a repaired index must let the successor resolve the capsule it names'
  );
});

test('a resolving reference is never reported as supporting the claim', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'semantic' });
  const run = beginRun(parent, { mode: 'full', objective: 'Something unrelated.' });
  const begun = getRunForTesting(run.id).events.find((event) => event.type === 'run_begun');

  // The reference resolves perfectly and proves only that the run began. Hash resolution is not
  // semantic support, and no allowlist fixes that — an unrelated but legitimate tool return would
  // prove the wrong action just as well.
  recordClaim(parent, 'I deployed production.', [`sha256:${begun.event_hash}`]);

  const { state, events } = getRunForTesting(run.id);
  const claim = labelClaims(events).at(-1);
  assert.equal(claim.support, 'REFERENCES_RESOLVE');
  assert.notEqual(claim.support, 'SUPPORTED', 'the current fold must never issue SUPPORTED');

  const capsule = buildContinuation(state, events);
  assert.equal(capsule.continuation_fold_version, 'v2');
  assert.deepEqual(capsule.settled, [], 'no builder claim is ever promoted into settled');
});

test('a packet folded by an earlier build still verifies, under the rules it was written by', (t) => {
  isolatedData(t);
  // v0 is the fold as it shipped through 0.1.31: any event could support any claim, and a
  // SUPPORTED claim was promoted into settled. That is a historical fact such a packet is entitled
  // to reproduce, so the v0 reducer must stay verbatim — re-folding it with current rules would
  // report an untampered packet as though someone had edited it.
  const parent = mintSession({ sessionId: 'legacy-fold' });
  const run = beginRun(parent, { mode: 'full', objective: 'Legacy window.' });
  const first = recordClaim(parent, 'I deployed production.', []);
  recordClaim(parent, 'I deployed production.', [`sha256:${first.event_hash}`]);
  const { state, events } = getRunForTesting(run.id);

  const legacy = buildContinuation(state, events, 'v0');
  assert.equal(labelClaims(events, 'verified_context', 'v0').at(-1).support, 'SUPPORTED');
  assert.match(JSON.stringify(legacy.settled), /deployed production/, 'v0 promoted it, and must still');
  assert.equal(legacy.continuation_fold_version, undefined, 'v0 capsules declare no fold version');

  // The same ledger under current rules reaches the opposite conclusion — which is the point of
  // keeping the two apart rather than letting one silently rewrite the other.
  const current = buildContinuation(state, events);
  assert.deepEqual(current.settled, []);
  assert.notEqual(legacy.capsule_ref, current.capsule_ref);
});

test('each shipped pre-versioned renderer retains its exact continuation shape', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'historical-shapes' });
  const run = beginRun(parent, { mode: 'full', objective: 'Objective text retained by newer builds.' });
  const first = recordClaim(parent, 'A human-readable claim.', []);
  recordClaim(parent, 'Second claim.', [`sha256:${first.event_hash}`]);
  const { state, events } = getRunForTesting(run.id);

  assert.deepEqual(foldCandidatesForRenderer('0.1.28'), ['v0_1_28']);
  assert.deepEqual(foldCandidatesForRenderer('0.1.29'), ['v0_1_29_30']);
  // One renderer string, two shipped shapes: objective_text entered the carry-forward mid-0.1.30,
  // before the release was cut. The released bundle folds v0; the pre-release commits folded
  // v0_1_29_30. The packet's own bytes pick between them at verification time.
  assert.deepEqual(foldCandidatesForRenderer('0.1.30'), ['v0', 'v0_1_29_30']);
  assert.deepEqual(foldCandidatesForRenderer('0.1.31'), ['v0']);
  assert.equal(foldCandidatesForRenderer('9.9.9'), null);

  const v028 = buildContinuation(state, events, 'v0_1_28');
  assert.equal(v028.privacy_mode, undefined, '0.1.28 shipped before privacy_mode entered the capsule');
  assert.equal(v028.objective_text, undefined, '0.1.28 shipped before objective text entered the capsule');
  assert.equal(v028.continuation_fold_version, undefined, 'historical capsules had no fold declaration');

  const v029 = buildContinuation(state, events, 'v0_1_29_30');
  assert.equal(v029.privacy_mode, 'verified_context', '0.1.29 and 0.1.30 included privacy_mode');
  assert.equal(v029.objective_text, undefined, '0.1.29 and 0.1.30 predated objective text carry-forward');
  assert.equal(v029.continuation_fold_version, undefined);

  const v031 = buildContinuation(state, events, 'v0');
  assert.equal(v031.privacy_mode, 'verified_context');
  assert.equal(v031.objective_text, 'Objective text retained by newer builds.');
  assert.equal(v031.continuation_fold_version, undefined);

  assert.notEqual(v028.state_hash, v029.state_hash, 'adding privacy_mode changed the shipped carry-forward hash');
  assert.notEqual(v029.state_hash, v031.state_hash, 'adding objective_text changed the shipped carry-forward hash');
});

test('genuine 0.1.28 through 0.1.31-shaped packets still verify through lineage', (t) => {
  for (const [renderer, foldVersion] of [
    ['0.1.28', 'v0_1_28'],
    ['0.1.29', 'v0_1_29_30'],
    ['0.1.30', 'v0_1_29_30'],
    ['0.1.30', 'v0'],
    ['0.1.31', 'v0']
  ]) {
    isolatedData(t);
    const prior = runWindow({ sessionId: `historical-${renderer}-prior`, objective: 'Historical window.' });
    const current = runWindow({
      sessionId: `historical-${renderer}-current`,
      objective: 'Successor window.',
      continuesFrom: prior.sealed.capsule_ref
    });
    const historical = recastHistoricalPacket(prior, current, renderer, foldVersion);
    assert.equal(historical.continuation_fold_version, undefined);

    const report = verifyLineage(prior.directory, current.directory);
    assert.equal(report.prior_renderer, renderer);
    assert.equal(report.prior_fold_version, foldVersion);
    assert.equal(
      report.ok,
      true,
      `${renderer} packet should remain LINKED:\n${report.checks.filter((item) => item.status !== 'PASS').map((item) => `${item.status} ${item.name}: ${item.detail}`).join('\n')}`
    );
  }
});

test('a renderer this checker cannot place is reported, never folded with current rules', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'unk-1', objective: 'First window.' });
  const second = runWindow({
    sessionId: 'unk-2',
    objective: 'Second window.',
    continuesFrom: first.sealed.capsule_ref
  });
  assert.ok(verifyLineage(first.directory, second.directory).ok, 'baseline must link');

  // Commit an unplaceable renderer and RE-CHAIN, so the ledger stays structurally valid and the
  // fold-version decision is what is actually under test. The trailing suffix matters: a lenient
  // parser reads "9.9.9-experimental" as 9.9.9 and silently selects the current reducer, which is
  // the one outcome this must never produce.
  // A historical/foreign packet: VALID semver the whitelist has never heard of, and no chained
  // fold declaration. "9.9.9" parses cleanly — an open-ended version range would map it onto the
  // current reducer and verify a fold this checker knows nothing about. The whitelist must not.
  rechainLedger(first.directory, (event) => {
    if (event.payload?.receipt_renderer) event.payload.receipt_renderer = '9.9.9';
    if (event.payload?.continuation_fold_version) delete event.payload.continuation_fold_version;
  });
  let report = verifyLineage(first.directory, second.directory);
  assert.equal(report.checks.find((item) => item.name === 'prior_chain_valid').status, 'PASS');
  assert.equal(report.prior_fold_version, null);
  let refolds = report.checks.find((item) => item.name === 'prior_continuation_refolds');
  assert.equal(refolds.status, 'NOT_RUN', 'a whitelisted-unknown renderer is reported, not folded with current rules');
  assert.match(refolds.detail, /cannot place/);
  assert.equal(report.ok, false, 'an unknown fold must fail safe');

  // A chained fold declaration this build does not implement. Same rule, other path. The prior
  // rechain stripped the field, so re-declare it on the anchor events themselves.
  rechainLedger(first.directory, (event) => {
    if (event.type === 'checkpoint_anchor' || event.type === 'run_sealed') event.payload.continuation_fold_version = 'v99';
  });
  report = verifyLineage(first.directory, second.directory);
  refolds = report.checks.find((item) => item.name === 'prior_continuation_refolds');
  assert.equal(refolds.status, 'NOT_RUN', 'a declared-but-unimplemented fold generation is reported');
  assert.match(refolds.detail, /does not implement/);
  assert.equal(report.ok, false);
});

test('the handoff never presents a resolving reference as cleared', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'surface' });
  const run = beginRun(parent, { mode: 'full', objective: 'Something unrelated.' });
  const begun = getRunForTesting(run.id).events.find((event) => event.type === 'run_begun');
  recordClaim(parent, 'I deployed production.', [`sha256:${begun.event_hash}`]);

  const { state, events } = getRunForTesting(run.id);
  const capsule = buildContinuation(state, events);

  // The reducer keeps it out of settled; the surface must not quietly clear it either. It is open
  // work, the pasted prompt says relevance was never evaluated, and the table column claims only
  // what the system checked.
  assert.ok(
    capsule.open.some((item) => /relevance to the claim was never evaluated/.test(item.statement)),
    'a REFERENCES_RESOLVE claim is open work, not silence'
  );
  const markdown = renderHandoffMarkdown(capsule);
  assert.match(markdown, /never evaluated — a resolving reference is not verification/);
  assert.match(markdown, /\| Reference check \| Claim \| Evidence cited \|/);
  assert.doesNotMatch(markdown, /\| Support \|/, 'the column must not claim a judgment the system does not make');
  const claim = capsule.claims.at(-1);
  assert.match(
    capsule.next.find((item) => item.ref === claim.ref)?.statement ?? '',
    /re-check.*relevance|relevance.*re-check/i,
    'the machine-readable next action must require the same relevance check as the handoff'
  );
});

test('a handoff taken before the run\'s final Stop still resolves and verifies', (t) => {
  isolatedData(t);
  // continuation.json is the run's CURRENT face and every later Stop overwrites it — so a handoff
  // taken at Stop N used to stop resolving the moment Stop N+1 ran. Each fold is now archived
  // immutably under its content-addressed ref, which is self-authenticating: a file either hashes
  // to its own name or it is not that capsule.
  const parent = mintSession({ sessionId: 'multi' });
  const run = beginRun(parent, { mode: 'full', objective: 'Long open window.' });
  recordClaim(parent, 'first stretch', []);
  checkpointOrSeal(parent, 'multi-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const refA = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;

  // The prior run keeps working past the fold that was handed off, so by the time the successor
  // opens, continuation.json no longer carries refA.
  recordClaim(parent, 'second stretch', []);
  checkpointOrSeal(parent, 'multi-stop-2');
  const refB = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;
  assert.notEqual(refA, refB, 'the run face moved past the handed-off fold');

  const next = mintSession({ sessionId: 'multi-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'From the first handoff.', continuesFrom: refA });
  checkpointOrSeal(next, 'multi-next-stop');

  assert.equal(
    getRunForTesting(successor.id).state.inherits.resolution,
    'RESOLVED_LOCAL_ARCHIVE',
    'a superseded fold resolves from its immutable archive, never UNRESOLVED_LOCALLY'
  );
  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.deepEqual(report.checks.map((item) => item.name), LINEAGE_CHECKS);
  assert.ok(report.ok, `the archived edge must verify:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);
  assert.match(
    report.checks.find((item) => item.name === 'inheritance_capsule_ref_matches').detail,
    /archived fold this run later superseded/,
    'which fold matched is stated, not hidden'
  );
});

test('a replayed Stop restores an archive lost after the visible handoff landed', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'crash-archive' });
  const run = beginRun(parent, { mode: 'full', objective: 'Crashes before archive write.' });
  checkpointOrSeal(parent, 'crash-archive-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const first = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  const archivePath = join(directory, 'capsules', `${first.capsule_ref}.json`);
  rmSync(archivePath);

  // The face, handoff, and index survived, so this is the tail branch that used to return without
  // recreating the archive. Replay the same Stop delivery, then let a later Stop move the face on.
  checkpointOrSeal(parent, 'crash-archive-stop-1');
  assert.ok(existsSync(archivePath), 'the replay must restore the current fold archive too');
  recordClaim(parent, 'Later work moved the current face.', []);
  checkpointOrSeal(parent, 'crash-archive-stop-2');

  const next = mintSession({ sessionId: 'crash-archive-next' });
  const successor = beginRun(next, {
    mode: 'full',
    objective: 'Continue the exact first handoff.',
    continuesFrom: first.capsule_ref
  });
  assert.equal(getRunForTesting(successor.id).state.inherits.resolution, 'RESOLVED_LOCAL_ARCHIVE');
});

test('an indexed archived fold that no longer hashes to its own name fails continuation closed', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'archive-integrity' });
  const run = beginRun(parent, { mode: 'full', objective: 'Produce two folds.' });
  checkpointOrSeal(parent, 'archive-integrity-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const first = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));

  recordClaim(parent, 'Move the current face past the archived fold.', []);
  checkpointOrSeal(parent, 'archive-integrity-stop-2');

  const archivePath = join(directory, 'capsules', `${first.capsule_ref}.json`);
  const tampered = JSON.parse(readFileSync(archivePath, 'utf8'));
  tampered.state_hash = 'f'.repeat(64);
  writeFileSync(archivePath, canonicalJson(tampered, true));

  const next = mintSession({ sessionId: 'archive-integrity-next' });
  assert.throws(
    () => beginRun(next, {
      mode: 'full',
      objective: 'Must not inherit a forged archive.',
      continuesFrom: first.capsule_ref
    }),
    /CONTINUATION_PREDECESSOR_UNAVAILABLE/
  );
});

test('lineage validates the signature on the archived fold actually inherited', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'archive-signature' });
  const run = beginRun(parent, { mode: 'full', objective: 'Produce a signed archived fold.' });
  checkpointOrSeal(parent, 'archive-signature-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const first = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));

  recordClaim(parent, 'Move the current face past the inherited fold.', []);
  checkpointOrSeal(parent, 'archive-signature-stop-2');

  const next = mintSession({ sessionId: 'archive-signature-next' });
  const successor = beginRun(next, {
    mode: 'full',
    objective: 'Inherit the first signed fold.',
    continuesFrom: first.capsule_ref
  });
  checkpointOrSeal(next, 'archive-signature-next-stop');

  const archivePath = join(directory, 'capsules', `${first.capsule_ref}.json`);
  const archived = JSON.parse(readFileSync(archivePath, 'utf8'));
  const prefix = archived.signature.signature.slice(0, 2);
  archived.signature.signature = `${prefix === '00' ? 'ff' : '00'}${archived.signature.signature.slice(2)}`;
  writeFileSync(archivePath, canonicalJson(archived, true));

  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.equal(report.checks.find((item) => item.name === 'prior_signature').status, 'FAIL');
  assert.equal(report.ok, false, 'an invalid signature on the inherited archive must prevent LINKED');
});

test('an indexed current continuation that no longer hashes to its own ref fails continuation closed', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'current-integrity' });
  const run = beginRun(parent, { mode: 'full', objective: 'Produce one fold.' });
  checkpointOrSeal(parent, 'current-integrity-stop');
  const directory = getRunForTesting(run.id).directory;
  const continuationPath = join(directory, 'continuation.json');
  const tampered = JSON.parse(readFileSync(continuationPath, 'utf8'));
  const committedRef = tampered.capsule_ref;
  tampered.state_hash = 'e'.repeat(64);
  writeFileSync(continuationPath, canonicalJson(tampered, true));
  rmSync(join(directory, 'capsules', `${committedRef}.json`));

  const next = mintSession({ sessionId: 'current-integrity-next' });
  assert.throws(
    () => beginRun(next, {
      mode: 'full',
      objective: 'Must not inherit an edited current face.',
      continuesFrom: committedRef
    }),
    /CONTINUATION_PREDECESSOR_UNAVAILABLE/
  );
});

test('a sealed packet that lost its handoff tail is repaired by seal verification', (t) => {
  const root = isolatedData(t);
  const { run, sealed, directory } = runWindow({ sessionId: 'sealtail', objective: 'Seals, then crashes mid-tail.' });

  // The crash window after run_sealed became durable: receipts and anchor exist, the handoff tail
  // does not. checkpointOrSeal excludes sealed runs, so repairSeal is the only path that ever
  // revisits this packet — and it previously stopped at the receipts.
  rmSync(join(directory, 'continuation.json'));
  rmSync(join(directory, 'HANDOFF.md'));
  rmSync(join(root, 'capsule-index'), { recursive: true, force: true });

  verifySealedRun(run.id);
  assert.ok(existsSync(join(directory, 'continuation.json')), 'seal verification must restore the capsule');
  assert.ok(existsSync(join(directory, 'HANDOFF.md')), 'and the handoff');

  const next = mintSession({ sessionId: 'sealtail-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: sealed.capsule_ref });
  assert.equal(getRunForTesting(successor.id).state.inherits.resolution, 'RESOLVED_LOCAL_PACKET');
});

test('a missing handoff is re-projected from a surviving capsule, even when the fold is ambiguous', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'amb-handoff' });
  const run = beginRun(parent, { mode: 'full', objective: 'Historical-shaped packet.' });
  recordClaim(parent, 'work', []);
  checkpointOrSeal(parent, 'amb-handoff-stop');
  const directory = getRunForTesting(run.id).directory;

  // Recast as a historical 0.1.30 packet: two fold candidates, no chained declaration. Candidate
  // ambiguity matters only when the CAPSULE must be regenerated; the handoff is a pure projection
  // of capsule bytes that survived, and skipping it left the artifact tail permanently incomplete.
  const ledgerPath = join(directory, 'events.jsonl');
  const events = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let previous = '0'.repeat(64);
  for (const event of events) {
    if (event.payload?.receipt_renderer) event.payload.receipt_renderer = '0.1.30';
    if (event.payload?.continuation_fold_version) delete event.payload.continuation_fold_version;
    event.prev_hash = previous;
    const { event_hash: _drop, ...rest } = event;
    event.event_hash = sha256(canonicalJson(rest));
    previous = event.event_hash;
  }
  writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  // A genuine 0.1.30 packet is internally consistent: its state and face agree with its ledger.
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.ledger_count = events.length;
  state.ledger_tip = events.at(-1).event_hash;
  writeFileSync(statePath, canonicalJson(state, true));
  writeFileSync(join(directory, 'continuation.json'), canonicalJson(buildContinuation(state, events, 'v0'), true));
  rmSync(join(directory, 'HANDOFF.md'));

  checkpointOrSeal(parent, 'amb-handoff-stop');
  assert.ok(existsSync(join(directory, 'HANDOFF.md')), 'the surviving capsule bytes must re-project the handoff');
});

test('an archive planted from another packet never verifies as this packet\'s inheritance', (t) => {
  isolatedData(t);
  // Content-addressing authenticates what an archive IS, not WHOSE it is: a valid signed archive
  // copied from run A into run B\'s packet passes ref and signature checks perfectly. The binding
  // that kills it is the ledger: the fold committed to a tip that must appear at the position it
  // names in THIS chain, and chains from different runs share no event hashes.
  const runA = mintSession({ sessionId: 'plant-a' });
  const a = beginRun(runA, { mode: 'full', objective: 'Run A.' });
  recordClaim(runA, 'a1', []);
  checkpointOrSeal(runA, 'plant-a-stop-1');
  const dirA = getRunForTesting(a.id).directory;
  const refA = JSON.parse(readFileSync(join(dirA, 'continuation.json'), 'utf8')).capsule_ref;
  recordClaim(runA, 'a2', []);
  checkpointOrSeal(runA, 'plant-a-stop-2');

  const succ = mintSession({ sessionId: 'plant-succ' });
  const successor = beginRun(succ, { mode: 'full', objective: 'Successor of A.', continuesFrom: refA });
  checkpointOrSeal(succ, 'plant-succ-stop');
  const successorDir = getRunForTesting(successor.id).directory;
  assert.ok(verifyLineage(dirA, successorDir).ok, 'the genuine edge must verify');

  const runB = mintSession({ sessionId: 'plant-b' });
  const b = beginRun(runB, { mode: 'full', objective: 'Unrelated run B.' });
  recordClaim(runB, 'b1', []);
  checkpointOrSeal(runB, 'plant-b-stop');
  const dirB = getRunForTesting(b.id).directory;
  mkdirSync(join(dirB, 'capsules'), { recursive: true });
  writeFileSync(join(dirB, 'capsules', `${refA}.json`), readFileSync(join(dirA, 'capsules', `${refA}.json`)));

  const report = verifyLineage(dirB, successorDir);
  assert.equal(report.ok, false, 'a planted archive must not make an unrelated packet LINKED');
});

test('an inherited legacy checkpoint is classified by its own anchor, not the upgraded face', (t) => {
  isolatedData(t);
  // A packet can span fold generations: a v0 checkpoint, an upgrade, a v1 face. The successor
  // inherited the v0 fold, and classifying by the face reported it as current — suppressing the
  // superseded-semantics warning for exactly the claims it applies to.
  const parent = mintSession({ sessionId: 'mixed' });
  const run = beginRun(parent, { mode: 'full', objective: 'Mixed-generation packet.' });
  recordClaim(parent, 'legacy-era work', []);
  evaluateAndRetrieve('mixed', parent, stableSnapshot, 'mixed-evaluator');
  checkpointOrSeal(parent, 'mixed-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const stopOneCount = readFileSync(join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  recordClaim(parent, 'current-era work', []);
  checkpointOrSeal(parent, 'mixed-stop-2');

  const successorSession = mintSession({ sessionId: 'mixed-next' });
  const successor = beginRun(successorSession, { mode: 'full', objective: 'Successor.', continuesFrom: 'f'.repeat(64) });
  checkpointOrSeal(successorSession, 'mixed-next-stop');
  const successorDir = getRunForTesting(successor.id).directory;

  // Recast the FIRST anchor as a 0.1.31 (v0) checkpoint; the second Stop stays v1.
  const priorEvents = rechainLedger(directory, (event) => {
    if (event.type === 'checkpoint_anchor' && event.payload?.covers_seq === stopOneCount - 1) {
      event.payload.receipt_renderer = '0.1.31';
      delete event.payload.continuation_fold_version;
    }
  });
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));

  // The v0 fold as the recast first Stop would have published it, archived under its own ref.
  const prefixState = { ...state, ledger_count: stopOneCount, ledger_tip: priorEvents[stopOneCount - 1].event_hash };
  const legacyCapsule = buildContinuation(prefixState, priorEvents.slice(0, stopOneCount), 'v0');
  rmSync(join(directory, 'capsules'), { recursive: true, force: true });
  mkdirSync(join(directory, 'capsules'), { recursive: true });
  writeFileSync(join(directory, 'capsules', `${legacyCapsule.capsule_ref}.json`), canonicalJson(legacyCapsule, true));

  // The current v1 face over the full rechained ledger.
  state.ledger_count = priorEvents.length;
  state.ledger_tip = priorEvents.at(-1).event_hash;
  writeFileSync(statePath, canonicalJson(state, true));
  const face = buildContinuation(state, priorEvents);
  writeFileSync(join(directory, 'continuation.json'), canonicalJson(face, true));
  writeFileSync(join(directory, 'capsules', `${face.capsule_ref}.json`), canonicalJson(face, true));

  // The successor's chained commitment names the legacy fold.
  const successorEvents = rechainLedger(successorDir, (event) => {
    if (event.type !== 'run_begun') return;
    event.payload.inherits = {
      capsule_ref: legacyCapsule.capsule_ref,
      state_hash: legacyCapsule.state_hash,
      run_id: run.id,
      resolution: 'RESOLVED_LOCAL_ARCHIVE'
    };
  });
  const successorStatePath = join(successorDir, 'state.json');
  const successorState = JSON.parse(readFileSync(successorStatePath, 'utf8'));
  successorState.ledger_count = successorEvents.length;
  successorState.ledger_tip = successorEvents.at(-1).event_hash;
  successorState.inherits = { capsule_ref: legacyCapsule.capsule_ref, state_hash: legacyCapsule.state_hash };
  writeFileSync(successorStatePath, canonicalJson(successorState, true));
  writeFileSync(join(successorDir, 'continuation.json'), canonicalJson(buildContinuation(successorState, successorEvents), true));

  const report = verifyLineage(directory, successorDir);
  assert.ok(report.ok, `mixed packet must verify:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);
  assert.equal(report.prior_capsule_ref, legacyCapsule.capsule_ref, 'the report names the inherited fold');
  assert.equal(report.prior_fold_version, 'v0', 'the prior fold field classifies the inherited archive');
  assert.equal(report.prior_renderer, '0.1.31');
  assert.equal(report.inherited_fold_version, 'v0', 'the inherited capsule is classified by its own anchor');
  assert.equal(
    report.prior_claim_semantics,
    'SUPERSEDED',
    'a legacy inherited fold must trigger the superseded-semantics warning even under a current face'
  );
  assert.match(renderLineageMarkdown(report), /superseded semantics/);
});

test('an inherited archive declaring an unimplemented generation fails safe, not LINKED', (t) => {
  isolatedData(t);
  // The archive is ref-matched and ledger-bound, but its own anchor declares a generation this
  // checker does not implement. The edge exists and cannot be verified: recording that as report
  // metadata after acceptance returned LINKED on a fold nothing checked. Unknown is NOT_RUN —
  // never a pass, and never a tampering FAIL the packet does not have.
  const parent = mintSession({ sessionId: 'unkfold' });
  const run = beginRun(parent, { mode: 'full', objective: 'Mixed with unknown generation.' });
  recordClaim(parent, 'work', []);
  checkpointOrSeal(parent, 'unkfold-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const stopOneCount = readFileSync(join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  recordClaim(parent, 'more', []);
  checkpointOrSeal(parent, 'unkfold-stop-2');

  const successorSession = mintSession({ sessionId: 'unkfold-next' });
  const successor = beginRun(successorSession, { mode: 'full', objective: 'Successor.', continuesFrom: 'e'.repeat(64) });
  checkpointOrSeal(successorSession, 'unkfold-next-stop');
  const successorDir = getRunForTesting(successor.id).directory;

  const priorEvents = rechainLedger(directory, (event) => {
    if (event.type === 'checkpoint_anchor' && event.payload?.covers_seq === stopOneCount - 1) {
      event.payload.continuation_fold_version = 'v999';
    }
  });
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const prefixState = { ...state, ledger_count: stopOneCount, ledger_tip: priorEvents[stopOneCount - 1].event_hash };
  const legacyCapsule = buildContinuation(prefixState, priorEvents.slice(0, stopOneCount));
  rmSync(join(directory, 'capsules'), { recursive: true, force: true });
  mkdirSync(join(directory, 'capsules'), { recursive: true });
  writeFileSync(join(directory, 'capsules', `${legacyCapsule.capsule_ref}.json`), canonicalJson(legacyCapsule, true));
  state.ledger_count = priorEvents.length;
  state.ledger_tip = priorEvents.at(-1).event_hash;
  writeFileSync(statePath, canonicalJson(state, true));
  writeFileSync(join(directory, 'continuation.json'), canonicalJson(buildContinuation(state, priorEvents), true));

  const successorEvents = rechainLedger(successorDir, (event) => {
    if (event.type !== 'run_begun') return;
    event.payload.inherits = { capsule_ref: legacyCapsule.capsule_ref, state_hash: legacyCapsule.state_hash, run_id: run.id, resolution: 'RESOLVED_LOCAL_ARCHIVE' };
  });
  const successorStatePath = join(successorDir, 'state.json');
  const successorState = JSON.parse(readFileSync(successorStatePath, 'utf8'));
  successorState.ledger_count = successorEvents.length;
  successorState.ledger_tip = successorEvents.at(-1).event_hash;
  successorState.inherits = { capsule_ref: legacyCapsule.capsule_ref, state_hash: legacyCapsule.state_hash };
  writeFileSync(successorStatePath, canonicalJson(successorState, true));
  writeFileSync(join(successorDir, 'continuation.json'), canonicalJson(buildContinuation(successorState, successorEvents), true));

  const report = verifyLineage(directory, successorDir);
  for (const name of ['inheritance_capsule_ref_matches', 'inheritance_state_hash_matches']) {
    const row = report.checks.find((item) => item.name === name);
    assert.equal(row.status, 'NOT_RUN', `${name} must be NOT_RUN for an unimplemented inherited generation`);
    assert.match(row.detail, /cannot place/);
  }
  assert.equal(report.inherited_fold_version, null);
  assert.equal(report.ok, false, 'an unverifiable inherited fold must fail safe');
});

test('a torn Stop tail is never regenerated once the ledger has moved past its anchor', (t) => {
  isolatedData(t);
  // The capsule is a Stop artifact. If the run recorded more events before the crashed Stop's
  // delivery was replayed, folding the full current ledger would publish post-Stop activity that
  // no Stop observed or anchored — a boundary fabricated by the repair path. A missing file that
  // reports honestly beats that; the next real Stop folds and anchors everything.
  const parent = mintSession({ sessionId: 'advanced' });
  const run = beginRun(parent, { mode: 'full', objective: 'Torn Stop, then more work.' });
  recordClaim(parent, 'pre-stop work', []);
  checkpointOrSeal(parent, 'advanced-stop-1');
  const directory = getRunForTesting(run.id).directory;
  rmSync(join(directory, 'continuation.json'));
  rmSync(join(directory, 'HANDOFF.md'));
  rmSync(join(directory, 'capsules'), { recursive: true, force: true });

  recordClaim(parent, 'post-stop work no Stop observed', []);
  checkpointOrSeal(parent, 'advanced-stop-1');   // the replayed delivery
  assert.ok(!existsSync(join(directory, 'continuation.json')), 'regeneration past the anchor must be declined');

  // The next REAL Stop completes the packet with an honest boundary.
  checkpointOrSeal(parent, 'advanced-stop-2');
  assert.ok(existsSync(join(directory, 'continuation.json')), 'the next Stop folds and anchors everything');
});

test('a legacy capsule with no privacy mode re-projects a handoff without inventing one', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'legacy-privacy' });
  const run = beginRun(parent, { mode: 'full', objective: 'Legacy shape.' });
  recordClaim(parent, 'work', []);
  const { state, events } = getRunForTesting(run.id);

  // 0.1.28 predates privacy modes entirely: the field is absent, and rendering that absence as
  // the string "undefined" would invent a value the fold never carried.
  const legacy = buildContinuation(state, events, 'v0_1_28');
  const markdown = renderHandoffMarkdown(legacy);
  assert.doesNotMatch(markdown, /undefined/);
  assert.doesNotMatch(markdown, /- Privacy mode:/, 'the line is omitted, not filled in');

  // Current capsules keep the line.
  const current = buildContinuation(state, events);
  assert.match(renderHandoffMarkdown(current), /- Privacy mode: `verified_context`/);
});

test('a lagging state cache is advanced over its anchor before the capsule is regenerated', (t) => {
  isolatedData(t);
  // Crash between the anchor append and saveState: the cache is one write behind, still carrying
  // pre-anchor count/tip. The regeneration gate correctly accepts it (it IS the committed state),
  // but folding with the lag published a capsule whose witnessed bookkeeping excluded the anchor —
  // and it stopped refolding the moment a normal read advanced state.json. An untampered packet
  // aging into a tamper report.
  const parent = mintSession({ sessionId: 'lag' });
  const run = beginRun(parent, { mode: 'full', objective: 'Lagging state crash.' });
  recordClaim(parent, 'work', []);
  checkpointOrSeal(parent, 'lag-stop');
  const directory = getRunForTesting(run.id).directory;
  const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const anchorEvent = events.at(-1);

  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.ledger_count = anchorEvent.payload.covers_seq;
  state.ledger_tip = events[anchorEvent.payload.covers_seq - 1].event_hash;
  writeFileSync(statePath, canonicalJson(state, true));
  rmSync(join(directory, 'continuation.json'));
  rmSync(join(directory, 'HANDOFF.md'));
  rmSync(join(directory, 'capsules'), { recursive: true, force: true });

  checkpointOrSeal(parent, 'lag-stop');   // the replayed delivery
  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.witnessed.event_count, events.length, 'the regenerated capsule must include the anchor');

  // A later normal read advances state.json to the tip; the capsule must still refold.
  const advanced = JSON.parse(readFileSync(statePath, 'utf8'));
  advanced.ledger_count = events.length;
  advanced.ledger_tip = anchorEvent.event_hash;
  writeFileSync(statePath, canonicalJson(advanced, true));

  const next = mintSession({ sessionId: 'lag-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: capsule.capsule_ref });
  checkpointOrSeal(next, 'lag-next-stop');
  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.ok(report.ok, `the repaired capsule must keep refolding:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);
});

test('a stale face left by a crashed later Stop is replaced, and its fold preserved', (t) => {
  isolatedData(t);
  // Stop N crashes after its anchor and saveState but before overwriting the face: Stop N-1's
  // capsule sits where N's should be. A file that exists and self-validates and is still WRONG —
  // presence is not currency. The replay must replace it at the anchored boundary, and the older
  // fold must survive in the archive so handoffs taken from it keep resolving.
  const parent = mintSession({ sessionId: 'staleface' });
  const run = beginRun(parent, { mode: 'full', objective: 'Stale face crash.' });
  recordClaim(parent, 'first stretch', []);
  checkpointOrSeal(parent, 'staleface-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const refA = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;
  recordClaim(parent, 'second stretch', []);
  checkpointOrSeal(parent, 'staleface-stop-2');
  const refB = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;

  writeFileSync(join(directory, 'continuation.json'), readFileSync(join(directory, 'capsules', `${refA}.json`)));
  rmSync(join(directory, 'capsules', `${refB}.json`));
  rmSync(join(directory, 'HANDOFF.md'));

  checkpointOrSeal(parent, 'staleface-stop-2');   // the replayed delivery
  const face = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(face.capsule_ref, refB, 'the face must be regenerated at the anchored boundary');
  assert.ok(existsSync(join(directory, 'capsules', `${refA}.json`)), 'the older fold stays archived');
  assert.ok(existsSync(join(directory, 'capsules', `${refB}.json`)), 'the regenerated fold is archived');
  assert.ok(existsSync(join(directory, 'HANDOFF.md')), 'the handoff is re-projected from the current face');

  const next = mintSession({ sessionId: 'staleface-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: refB });
  checkpointOrSeal(next, 'staleface-next-stop');
  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.ok(report.ok, `the repaired packet must verify:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);
});

test('an issued handoff is not invalidated by activity after its Stop', (t) => {
  isolatedData(t);
  // Checkpoint, successor inherits the face, prior run records one more event and never Stops
  // again — the abandoned-window case with a straggler event. The face's committed boundary is a
  // genuine anchored prefix of the ledger, so it verifies against that prefix exactly as its
  // archived copy would; a single post-Stop event must not flip refolds on an untouched packet.
  const parent = mintSession({ sessionId: 'straggler' });
  const run = beginRun(parent, { mode: 'full', objective: 'Handoff, then a little more work.' });
  recordClaim(parent, 'work', []);
  checkpointOrSeal(parent, 'straggler-stop');
  const directory = getRunForTesting(run.id).directory;
  const ref = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;

  const next = mintSession({ sessionId: 'straggler-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: ref });
  checkpointOrSeal(next, 'straggler-next-stop');

  recordClaim(parent, 'a little more work after the handoff', []);

  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.ok(report.ok, `later activity must not invalidate the issued handoff:\n${report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);

  // A tampered face must still fail: currency at a prefix is earned by refolding, not presumed.
  const capsulePath = join(directory, 'continuation.json');
  const face = JSON.parse(readFileSync(capsulePath, 'utf8'));
  face.objective = 'edited after the fact';
  writeFileSync(capsulePath, canonicalJson(face, true));
  assert.equal(verifyLineage(directory, getRunForTesting(successor.id).directory).ok, false);
});

test('a post-seal tail fails closed; the prefix treatment never slices it away', (t) => {
  isolatedData(t);
  // run_sealed is terminal — the invariant repairSeal enforces. A validly hash-chained event
  // appended after the seal is corruption, and the open-face prefix treatment must not rescue it
  // into a LINKED verdict the store itself would refuse.
  const first = runWindow({ sessionId: 'tail-1', objective: 'Sealed window.' });
  const second = runWindow({
    sessionId: 'tail-2',
    objective: 'Successor.',
    continuesFrom: first.sealed.capsule_ref
  });
  assert.ok(verifyLineage(first.directory, second.directory).ok, 'baseline must link');

  const ledgerPath = join(first.directory, 'events.jsonl');
  const events = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tip = events.at(-1);
  const forged = { seq: events.length + 1, type: 'builder_claim', origin: 'agent_reported', payload: { statement: 'post-seal append' }, prev_hash: tip.event_hash };
  const { event_hash: _drop, ...rest } = forged;
  forged.event_hash = sha256(canonicalJson(rest));
  writeFileSync(ledgerPath, `${[...events, forged].map((event) => JSON.stringify(event)).join('\n')}\n`);

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false, 'a chained post-seal tail must fail closed');
  assert.match(
    report.checks.find((item) => item.name === 'prior_continuation_refolds').detail,
    /continues past run_sealed/
  );
});

test('a forged archive cannot vouch for itself: the refold is seeded from the packet, not the archive', (t) => {
  const dataRoot = isolatedData(t);
  // The archived-Stop refold once seeded objective and objective_text from the archive under
  // verification — circular. Forge both fields, recompute state_hash and capsule_ref (honest
  // hashes OF the forgery), plant the archive and its index entry, mint a successor from the
  // forged ref: every check passed. The refold must be seeded from the packet's own retained
  // state, which still holds the objective the run actually began with.
  const parent = mintSession({ sessionId: 'forge-objective' });
  const run = beginRun(parent, { mode: 'full', objective: 'The objective the run began with.' });
  recordClaim(parent, 'first stretch', []);
  checkpointOrSeal(parent, 'forge-objective-stop-1');
  const directory = getRunForTesting(run.id).directory;
  const refA = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref;
  recordClaim(parent, 'second stretch', []);
  checkpointOrSeal(parent, 'forge-objective-stop-2');

  const forged = JSON.parse(readFileSync(join(directory, 'capsules', `${refA}.json`), 'utf8'));
  delete forged.signature;
  forged.objective = 'An objective the run never had.';
  forged.objective_text = 'An objective the run never had.';
  forged.state_hash = deriveStateHash(forged);
  forged.capsule_ref = deriveCapsuleRef(forged);
  writeFileSync(join(directory, 'capsules', `${forged.capsule_ref}.json`), canonicalJson(forged, true));
  mkdirSync(join(dataRoot, 'capsule-index'), { recursive: true });
  writeFileSync(join(dataRoot, 'capsule-index', `${sha256(forged.capsule_ref)}.json`), JSON.stringify({ run_id: run.id, capsule_ref: forged.capsule_ref }));

  const next = mintSession({ sessionId: 'forge-objective-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: forged.capsule_ref });
  checkpointOrSeal(next, 'forge-objective-next-stop');
  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.equal(report.ok, false, 'a self-vouching forged archive must not verify');
  assert.match(
    report.checks.find((item) => item.name === 'prior_continuation_refolds').detail,
    /inherited archive does not reproduce/
  );

  // The genuine archived fold at the same boundary keeps verifying.
  const honest = mintSession({ sessionId: 'forge-objective-honest' });
  const honestRun = beginRun(honest, { mode: 'full', objective: 'Honest successor.', continuesFrom: refA });
  checkpointOrSeal(honest, 'forge-objective-honest-stop');
  const honestReport = verifyLineage(directory, getRunForTesting(honestRun.id).directory);
  assert.ok(honestReport.ok, `the genuine archived fold must still verify:\n${honestReport.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}`);
});

test('an archived fold is only inheritable at a boundary a Stop published', (t) => {
  const dataRoot = isolatedData(t);
  // Residence proves the archive's committed tip is IN the chain; it does not prove any Stop
  // published a fold there. Fold the open ledger's prefix ending at a post-checkpoint
  // builder_claim — honest bytes, honest content hash, a boundary no Stop anchored — plant it
  // with an index entry, and mint a successor: every check passed. The boundary event must be a
  // checkpoint_anchor, the same rule the face-prefix path enforces.
  const parent = mintSession({ sessionId: 'midclaim' });
  const run = beginRun(parent, { mode: 'full', objective: 'Open run folded mid-claim by hand.' });
  checkpointOrSeal(parent, 'midclaim-stop-1');
  recordClaim(parent, 'claim recorded after the checkpoint', []);
  checkpointOrSeal(parent, 'midclaim-stop-2');
  const directory = getRunForTesting(run.id).directory;

  const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const boundary = events.findIndex((event) => event.type === 'builder_claim') + 1;
  assert.ok(boundary > 0, 'the fixture needs a builder_claim to fold at');
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  state.sealed = false;
  state.close_requested = null;
  state.ledger_count = boundary;
  state.ledger_tip = events[boundary - 1].event_hash;
  const crafted = buildContinuation(state, events.slice(0, boundary));
  writeFileSync(join(directory, 'capsules', `${crafted.capsule_ref}.json`), canonicalJson(crafted, true));
  mkdirSync(join(dataRoot, 'capsule-index'), { recursive: true });
  writeFileSync(join(dataRoot, 'capsule-index', `${sha256(crafted.capsule_ref)}.json`), JSON.stringify({ run_id: run.id, capsule_ref: crafted.capsule_ref }));

  const next = mintSession({ sessionId: 'midclaim-next' });
  const successor = beginRun(next, { mode: 'full', objective: 'Successor.', continuesFrom: crafted.capsule_ref });
  checkpointOrSeal(next, 'midclaim-next-stop');
  const report = verifyLineage(directory, getRunForTesting(successor.id).directory);
  assert.equal(report.ok, false, 'a fold no Stop published must not be inheritable');
  assert.equal(report.checks.find((item) => item.name === 'inheritance_capsule_ref_matches').ok, false);
});

test('sealing writes a handoff that carries the unsupported claims forward', (t) => {
  isolatedData(t);
  const { run, sealed, directory } = runWindow({
    sessionId: 'handoff',
    objective: 'Ship the lane.',
    claims: [{ statement: 'I definitely deployed this to production.' }]
  });

  assert.ok(existsSync(join(directory, 'HANDOFF.md')));
  assert.ok(existsSync(join(directory, 'continuation.json')));
  assert.equal(sealed.capsule_ref, JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref);

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /the previous agent did not write it/);
  assert.match(handoff, /UNSUPPORTED/);
  assert.match(handoff, /have no witnessed support in that run/);
  assert.match(handoff, new RegExp(sealed.capsule_ref));

  // The capsule the handoff renders from must be the run's own fold, plus its signature.
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  const { state, events } = getRunForTesting(run.id);
  assert.equal(deriveCapsuleRef(published), buildContinuation(state, events).capsule_ref);
  assert.equal(renderHandoffMarkdown(published), handoff);
});

test('every Stop refreshes the handoff, so an abandoned window still hands off', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'abandoned' });
  const run = beginRun(parent, { mode: 'full', objective: 'Run out of context.' });
  recordClaim(parent, 'Partial work happened.', []);

  // No close request — this window is simply left behind, which is the common real case.
  const checkpoint = checkpointOrSeal(parent);
  assert.notEqual(checkpoint.status, 'SEALED');

  const directory = getRunForTesting(run.id).directory;
  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.status, 'OPEN');
  assert.ok(capsule.open.some((item) => /No close request was observed/.test(item.statement)));
  assert.ok(existsSync(join(directory, 'HANDOFF.md')));
});

test('a second window that continues the first verifies as linked', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'window-1', objective: 'First window.' });
  const second = runWindow({
    sessionId: 'window-2',
    objective: 'Second window.',
    continuesFrom: first.sealed.capsule_ref
  });

  // The edge resolved locally and recorded the PRIOR packet's state hash, not a caller-supplied one.
  assert.equal(second.run.inherits.resolution, 'RESOLVED_LOCAL_PACKET');
  assert.equal(second.run.inherits.run_id, first.run.id);

  // And it lives inside the hash chain.
  const runBegun = getRunForTesting(second.run.id).events.find((event) => event.type === 'run_begun');
  assert.equal(runBegun.payload.inherits.capsule_ref, first.sealed.capsule_ref);

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.ok(report.checks.every((item) => item.ok));
  assert.match(report.trust_notice, /does NOT prove the observations were true/);
  assert.match(report.trust_notice, /not custody against the machine that produced the packet/);
});

test('lineage fails when the second window commits to a different capsule', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'real-1', objective: 'The real prior window.' });
  const decoy = runWindow({ sessionId: 'decoy', objective: 'A different window entirely.' });
  const second = runWindow({
    sessionId: 'real-2',
    objective: 'Continues the decoy, not the first.',
    continuesFrom: decoy.sealed.capsule_ref
  });

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  const mismatch = report.checks.find((item) => item.name === 'inheritance_capsule_ref_matches');
  assert.equal(mismatch.ok, false);
});

test('lineage fails when a published continuation is edited after the fact', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'edited-1', objective: 'Original objective.' });
  const second = runWindow({
    sessionId: 'edited-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });
  assert.equal(verifyLineage(first.directory, second.directory).ok, true);

  // Rewrite the prior handoff's settled list AND restamp its identity so the file is internally
  // self-consistent. Only re-folding from the ledger catches this.
  const path = join(first.directory, 'continuation.json');
  const tampered = JSON.parse(readFileSync(path, 'utf8'));
  tampered.settled.push({ statement: 'A fact nobody witnessed.', ref: null });
  tampered.capsule_ref = deriveCapsuleRef(tampered);
  writeFileSync(path, canonicalJson(tampered, true));

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_capsule_ref_self_consistent').ok, true);
  assert.equal(report.checks.find((item) => item.name === 'prior_continuation_refolds').ok, false);
});

/**
 * The row set, written out as literals on purpose. Comparing a report against a baseline built from
 * the same CHECK_SEQUENCE only proves the two agree — delete a check from that constant and both
 * sides lose it in step, silently, while the suite stays green. Only literals pin the set itself.
 */
const LINEAGE_CHECKS = [
  'prior_continuation_present',
  'prior_capsule_ref_self_consistent',
  'prior_state_hash_self_consistent',
  'prior_chain_valid',
  'prior_continuation_refolds',
  'prior_signature',
  'current_chain_valid',
  'current_declares_inheritance',
  'inheritance_capsule_ref_matches',
  'inheritance_state_hash_matches'
];

test('a check that could not run is reported NOT RUN, never dropped from the report', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'notrun-1', objective: 'Original window.' });
  const second = runWindow({
    sessionId: 'notrun-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });

  const clean = verifyLineage(first.directory, second.directory);
  assert.equal(clean.ok, true, JSON.stringify(clean.checks, null, 2));

  // Break the prior ledger itself: edit an event's content so it no longer hashes to its recorded
  // event_hash. The re-fold now has no trustworthy input — but a reader must be told that, not left
  // to notice a missing row.
  const ledgerPath = join(first.directory, 'events.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim());
  const opening = JSON.parse(lines[0]);
  opening.payload = { ...opening.payload, mode: 'pr_only' };
  lines[0] = JSON.stringify(opening);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_chain_valid').status, 'FAIL');

  const refolds = report.checks.find((item) => item.name === 'prior_continuation_refolds');
  assert.equal(refolds.status, 'NOT_RUN');
  assert.equal(refolds.ok, false, 'an unknown must never count as a pass');
  assert.match(refolds.detail, /does not chain-validate/);

  // Same rows, same order, whatever the outcome — a row must never vanish between two reports.
  assert.deepEqual(
    report.checks.map((item) => item.name),
    clean.checks.map((item) => item.name)
  );
  assert.deepEqual(clean.checks.map((item) => item.name), LINEAGE_CHECKS);
  assert.deepEqual(report.checks.map((item) => item.name), LINEAGE_CHECKS);
  assert.match(renderLineageMarkdown(report), /NOT RUN — `prior_continuation_refolds`/);
});

test('a packet with nothing to check still reports every check it did not run', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'empty-1', objective: 'Window with a deleted capsule.' });
  const second = runWindow({
    sessionId: 'empty-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });
  const complete = verifyLineage(first.directory, second.directory).checks.map((item) => item.name);

  rmSync(join(first.directory, 'continuation.json'));

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_continuation_present').status, 'FAIL');
  assert.deepEqual(report.checks.map((item) => item.name), complete);
  assert.deepEqual(report.checks.map((item) => item.name), LINEAGE_CHECKS);
  for (const item of report.checks.slice(1)) {
    assert.equal(item.status, 'NOT_RUN', `${item.name} should be NOT RUN, not omitted`);
  }
});

test('a destroyed packet file is a recorded finding, not a thrown error', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'broken-1', objective: 'Original window.' });
  const second = runWindow({
    sessionId: 'broken-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });
  const continuationPath = join(first.directory, 'continuation.json');
  const statePath = join(first.directory, 'state.json');
  const ledgerPath = join(first.directory, 'events.jsonl');
  const intact = {
    continuation: readFileSync(continuationPath, 'utf8'),
    state: readFileSync(statePath, 'utf8'),
    ledger: readFileSync(ledgerPath, 'utf8')
  };
  const restore = () => {
    writeFileSync(continuationPath, intact.continuation);
    writeFileSync(statePath, intact.state);
    writeFileSync(ledgerPath, intact.ledger);
  };

  // A one-byte truncation is the tamper this checker exists to catch. It must produce a report.
  for (const [label, corrupt, failing] of [
    ['emptied continuation.json', () => writeFileSync(continuationPath, ''), 'prior_continuation_present'],
    ['truncated continuation.json', () => writeFileSync(continuationPath, intact.continuation.slice(0, 20)), 'prior_continuation_present'],
    ['continuation.json holding JSON null', () => writeFileSync(continuationPath, 'null'), 'prior_continuation_present'],
    ['emptied state.json', () => writeFileSync(statePath, ''), 'prior_continuation_refolds'],
    ['malformed state.json', () => writeFileSync(statePath, '{oops'), 'prior_continuation_refolds'],
    ['a ledger line holding JSON null', () => writeFileSync(ledgerPath, `null\n${intact.ledger}`), 'prior_chain_valid'],
    ['emptied events.jsonl', () => writeFileSync(ledgerPath, ''), 'prior_chain_valid']
  ]) {
    restore();
    corrupt();
    const report = verifyLineage(first.directory, second.directory);
    assert.deepEqual(report.checks.map((item) => item.name), LINEAGE_CHECKS, `${label}: full row set`);
    assert.equal(report.ok, false, `${label}: must not be LINKED`);
    assert.equal(report.checks.find((item) => item.name === failing).status, 'FAIL', `${label}: ${failing} should FAIL`);
    assert.doesNotMatch(renderLineageMarkdown(report), /undefined/, `${label}: renders without holes`);
  }
  restore();
});

test('an emptied ledger is a destroyed chain, not a valid chain of length zero', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'emptyledger-1', objective: 'Original window.' });
  writeFileSync(join(first.directory, 'events.jsonl'), '');

  const chain = verifyLedgerChain(first.directory);
  assert.equal(chain.ok, false, 'deleting every event must never read as a passing chain');
  assert.match(chain.detail, /empty/);
});

test('a predecessor this store cannot see is recorded as unresolved, not invented', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'stranger' });
  const run = beginRun(parent, { mode: 'full', objective: 'Continue a packet from another machine.', continuesFrom: 'f'.repeat(64) });

  assert.equal(run.inherits.resolution, 'UNRESOLVED_LOCALLY');
  assert.equal(run.inherits.capsule_ref, 'f'.repeat(64));
  assert.equal(run.inherits.state_hash, null);
});

test('the lineage checker re-walks the chain itself rather than trusting the store reader', (t) => {
  isolatedData(t);
  const { directory } = runWindow({ sessionId: 'chain', objective: 'Chain check.' });
  assert.equal(verifyLedgerChain(directory).ok, true);

  const ledgerPath = join(directory, 'events.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.payload = { ...first.payload, objective_origin: 'runtime_hook' };
  lines[0] = canonicalJson(first);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const broken = verifyLedgerChain(directory);
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /hash does not match its content/);
});

test('the owner sees their own claim: verified context retains the words', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'plain',
    objective: 'Read my own claims.',
    claims: [{ statement: 'I deployed the migration to production and it succeeded.' }]
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.privacy_mode, 'verified_context');
  assert.equal(capsule.claims[0].statement_text, 'I deployed the migration to production and it succeeded.');

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /I deployed the migration to production and it succeeded\./);
  assert.ok(capsule.open.some((item) => /I deployed the migration to production/.test(item.statement)));
});

test('proof mode projects the words away but keeps the verdict auditable', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'blind',
    objective: 'Share this packet.',
    privacyMode: 'proof',
    claims: [{ statement: 'I deployed the migration to production and it succeeded.' }]
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.privacy_mode, 'proof');
  assert.equal(capsule.claims[0].statement_text, undefined);
  assert.equal(capsule.claims[0].support, 'UNSUPPORTED');
  assert.ok(capsule.claims[0].builder_claim_id, 'the claim stays addressable by a non-prose supervisor identity');
  assert.equal(capsule.claims[0].statement_ref, null, 'proof mode stores no prose-derived statement hash');

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.doesNotMatch(handoff, /I deployed the migration/);
  assert.match(handoff, /claim text is projected away in this packet/);
  assert.match(handoff, /UNSUPPORTED/);
  assert.doesNotMatch(readFileSync(join(directory, 'receipt.json'), 'utf8'), /I deployed the migration/);
});

test('secrets are still scrubbed from retained claim text', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'secrets',
    objective: 'Do not leak.',
    claims: [{ statement: 'Deployed with token=ghp_abcdefghijklmnopqrstuvwxyz012345 as configured.' }]
  });

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Deployed with/);
  assert.doesNotMatch(handoff, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(handoff, /REDACTED/);
});

test('privacy mode is sealed into the chain, so rendering never depends on the environment', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({
    sessionId: 'sealed-mode',
    objective: 'Determinism.',
    privacyMode: 'proof',
    claims: [{ statement: 'A claim whose words are withheld.' }]
  });

  const runBegun = getRunForTesting(run.id).events.find((event) => event.type === 'run_begun');
  assert.equal(runBegun.payload.privacy_mode, 'proof');

  const { signature: _published, ...before } = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  process.env.LYHNA_PRIVACY_MODE = 'verified_context';
  t.after(() => { delete process.env.LYHNA_PRIVACY_MODE; });
  const { state, events } = getRunForTesting(run.id);
  assert.equal(canonicalJson(buildContinuation(state, events)), canonicalJson(before));
});

test('the request survives the handoff instead of arriving as a byte count', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'objective',
    objective: 'Port the judgment ledger and close the drift on the canonical context.'
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, 'Port the judgment ledger and close the drift on the canonical context.');
  assert.match(capsule.objective, /retained by hash/, 'the structural summary is kept alongside');

  // The next window reads the request, not its length.
  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Port the judgment ledger and close the drift/);
});

test('proof mode withholds the request from a packet that leaves the machine', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'objective-blind',
    objective: 'Port the judgment ledger and close the drift on the canonical context.',
    privacyMode: 'proof'
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, undefined);
  assert.equal(capsule.objective, 'Objective withheld.');

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.doesNotMatch(handoff, /Port the judgment ledger/);
  assert.match(handoff, /text withheld in this packet/);
});

test('the retained request carries forward into the inherited state hash', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'obj-1', objective: 'The original request.' });
  const second = runWindow({ sessionId: 'obj-2', objective: 'Continues it.', continuesFrom: first.sealed.capsule_ref });

  // objective_text is part of the carry-forward core, so a successor commits to the request itself
  // and not merely to its shape.
  assert.equal(verifyLineage(first.directory, second.directory).ok, true);
  const capsule = JSON.parse(readFileSync(join(first.directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, 'The original request.');
});
