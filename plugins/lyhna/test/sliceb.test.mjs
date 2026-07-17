import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  addPrSnapshot,
  beginEvaluation,
  beginRun,
  checkpointOrSeal,
  claimEvaluation,
  getRunForTesting,
  markSnapshotRefreshed,
  mintChild,
  mintSession,
  readSealedReceipt,
  recordEvaluation,
  recordRejectedClaim,
  requestClose,
  sealChildByAgent
} from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { buildReceipt, renderReceiptMarkdown } from '../src/receipt.mjs';
import { sha256 } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function evaluateSnapshot(sessionId, parent, snapshot, agentId) {
  addPrSnapshot(parent, snapshot);
  const evaluation = beginEvaluation(
    parent,
    snapshot.id,
    { head: snapshot.head_after, clean: true, detached: true, path: `fixture-${snapshot.id}` },
    snapshot.trigger
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
  return evaluation;
}

function sealMultiHeadRun({ sessionId, snapshots, refreshFinal }) {
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Multi-head PR run.' });
  snapshots.forEach((snapshot, index) => evaluateSnapshot(sessionId, parent, snapshot, `evaluator-${index}`));
  if (refreshFinal) {
    const finalSnapshot = snapshots[snapshots.length - 1];
    markSnapshotRefreshed(parent, finalSnapshot.id, finalSnapshot.head_after);
  }
  requestClose(parent, 'Close the multi-head run.');
  const sealed = checkpointOrSeal(parent);
  assert.equal(sealed.status, 'SEALED');
  const { state, events, directory } = getRunForTesting(run.id);
  const receipt = buildReceipt(state, events);
  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  return { parent, run, receipt, markdown };
}

// B-2 + B-3: the Rooms-run shape — a PR whose head moved mid-run, sealed WITH a post-evaluation refresh.
test('Rooms-run shape sealed with a refresh renders exactly one CURRENT head and a SUPERSEDED predecessor', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [
    { ...stableSnapshot, id: 'pr_head_a', head_before: HEAD_A, head_after: HEAD_A },
    { ...stableSnapshot, id: 'pr_head_b', head_before: HEAD_B, head_after: HEAD_B }
  ];
  const { receipt, markdown } = sealMultiHeadRun({ sessionId: 'rooms-with-refresh', snapshots, refreshFinal: true });
  assert.equal(receipt.pr_head_chains.length, 1);
  const chain = receipt.pr_head_chains[0];
  assert.equal(chain.heads.length, 2);
  const labels = chain.heads.map((head) => head.chain_label);
  assert.deepEqual(labels, ['SUPERSEDED', 'CURRENT']);
  assert.equal(labels.filter((label) => label === 'CURRENT').length, 1);
  // B-3: every head names all four rungs; acceptance is always the boundary.
  for (const head of chain.heads) {
    assert.match(head.ladder.workflow_checks[0].statement, /check-run named "test": state SUCCESS/);
    assert(!/approv|accept|fixed/i.test(head.ladder.workflow_checks[0].statement));
    assert.match(head.ladder.acceptance, /acceptance is the operator's decision/);
  }
  // Fix 1: rung 3 is constitutionally constant — never asserts findings addressed. The later head's
  // evaluation surfaces only as a plain, strictly observational note.
  assert.equal(chain.heads[0].ladder.findings_addressed, 'Not established by this record.');
  assert.equal(chain.heads[1].ladder.findings_addressed, 'Not established by this record.');
  assert.equal(chain.heads[0].ladder.later_reevaluations.length, 1);
  assert.equal(chain.heads[0].ladder.later_reevaluations[0].head, HEAD_B);
  assert.match(chain.heads[0].ladder.later_reevaluations[0].statement, /a later evaluation at head .* was recorded/i);
  assert(!/address|fixed|resolved/i.test(chain.heads[0].ladder.later_reevaluations[0].statement));
  assert.equal(chain.heads[1].ladder.later_reevaluations.length, 0);
  assert.match(markdown, /Head `bbbbbbbb.*: \*\*CURRENT\*\*/);
  assert.match(markdown, /Head `aaaaaaaa.*: \*\*SUPERSEDED\*\*/);
});

// B-2: the same shape sealed WITHOUT a post-evaluation refresh must render NOT_REFRESHED, never silently CURRENT.
test('Rooms-run shape sealed without a refresh renders the final head NOT_REFRESHED', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [
    { ...stableSnapshot, id: 'pr_head_a', head_before: HEAD_A, head_after: HEAD_A },
    { ...stableSnapshot, id: 'pr_head_b', head_before: HEAD_B, head_after: HEAD_B }
  ];
  const { receipt } = sealMultiHeadRun({ sessionId: 'rooms-no-refresh', snapshots, refreshFinal: false });
  const labels = receipt.pr_head_chains[0].heads.map((head) => head.chain_label);
  assert.deepEqual(labels, ['SUPERSEDED', 'NOT_REFRESHED']);
  assert.equal(labels.filter((label) => label === 'CURRENT').length, 0);
});

// B-1: the sealed receipt is self-contained — a reader can credit the seal and reconstruct closeout order.
test('sealed receipt embeds a self-contained seal block with anchor hash and ledger order', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [{ ...stableSnapshot, id: 'pr_single', head_before: HEAD_A, head_after: HEAD_A }];
  const { run, receipt, markdown } = sealMultiHeadRun({ sessionId: 'seal-selfcontained', snapshots, refreshFinal: true });
  const anchor = JSON.parse(readFileSync(join(getRunForTesting(run.id).directory, 'seal-anchor.json'), 'utf8'));
  assert.equal(receipt.seal.status, 'SEALED');
  assert.equal(receipt.seal.seal_anchor_hash, `sha256:${anchor.state_hash}`);
  assert.equal(receipt.seal.ledger_tip_hash, `sha256:${anchor.final_hash}`);
  assert.equal(receipt.seal.event_count, anchor.final_seq);
  assert.match(receipt.seal.evidence_order, /ordered strictly by ledger sequence/);
  assert.match(receipt.seal.verification, /hash-chain consistency/);
  assert.match(receipt.seal.verification, /not prove adversary-resistant custody/);
  // Closeout order is reconstructable from seq alone.
  const seqs = receipt.evidence.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert(receipt.seal.child_retrieval_at_closeout.every((child) => child.retrieved === true));
  assert.match(markdown, /## Seal/);
  assert.match(markdown, /Seal-anchor hash:/);
});

// B-5: two evaluations at the identical head are distinguishable by trigger on the receipt face.
test('evaluations at the identical head are distinguishable by trigger', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [
    { ...stableSnapshot, id: 'pr_first_pass', head_before: HEAD_A, head_after: HEAD_A, trigger: 'initial' },
    { ...stableSnapshot, id: 'pr_reexam', head_before: HEAD_A, head_after: HEAD_A, trigger: 're_examination' }
  ];
  const { receipt } = sealMultiHeadRun({ sessionId: 'trigger-distinct', snapshots, refreshFinal: true });
  const triggers = receipt.evaluations.map((evaluation) => evaluation.trigger).sort();
  assert.deepEqual(triggers, ['initial', 're_examination']);
  const chain = receipt.pr_head_chains[0];
  // Fix 4: two snapshots at the identical head render ONE chain entry — no head progression occurred.
  assert.equal(chain.heads.length, 1);
  assert.equal(chain.heads[0].snapshot_ids.length, 2);
  assert(!chain.heads.some((head) => head.chain_label === 'SUPERSEDED'));
  // Both evaluations remain visible within the single entry, still distinguishable by trigger.
  const renderedTriggers = chain.heads.flatMap((head) => head.ladder.independent_evaluation.map((item) => item.trigger)).sort();
  assert.deepEqual(renderedTriggers, ['initial', 're_examination']);
});

// B-5: an absent trigger is recorded as unspecified and never inferred.
test('absent evaluation trigger is recorded as unspecified', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [{ ...stableSnapshot, id: 'pr_default_trigger', head_before: HEAD_A, head_after: HEAD_A }];
  const { receipt } = sealMultiHeadRun({ sessionId: 'trigger-default', snapshots, refreshFinal: true });
  assert.equal(receipt.evaluations[0].trigger, 'unspecified');
});

// B-4: the coverage boundary is answerable from the receipt text alone.
test('coverage boundary states invocation, delegated-child, and witnessing evidence', { concurrency: false }, (t) => {
  isolatedData(t);
  // agent_reported run with no children: earlier session activity was not observed; no child lifecycle.
  const agentReported = buildReceipt(
    {
      id: 'run_ar',
      mode: 'full',
      sealed: true,
      objective: 'x',
      objective_origin: 'agent_reported',
      configured_hooks: ['SessionStart'],
      children: {},
      child_receipts: {},
      pr_snapshots: {},
      evaluations: {}
    },
    [{ seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: { mode: 'full', objective_origin: 'agent_reported' } }]
  );
  assert.match(agentReported.coverage.invocation, /No hook-observed invocation preceded this run/);
  assert.equal(agentReported.coverage.child_lifecycle, 'No ordinary delegated-child lifecycle was observed during this run.');
  assert.match(agentReported.coverage.witnessing_boundary, /Witnessing began at this run's first event; earlier session activity was not observed/);

  // runtime_hook run: invocation form/offset stated, no boundary caveat.
  const hookRun = buildReceipt(
    {
      id: 'run_hook',
      mode: 'full',
      sealed: true,
      objective: 'x',
      objective_origin: 'runtime_hook',
      configured_hooks: ['SessionStart'],
      children: { agent: { id: 'child_x' } },
      child_receipts: {},
      pr_snapshots: {},
      evaluations: {}
    },
    [{ seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: { mode: 'full', objective_origin: 'runtime_hook', invocation: { matched_form: 'literal_short', mention_offset: 7 } } }]
  );
  assert.match(hookRun.coverage.invocation, /matched form "literal_short" at prompt offset 7/);
  assert.match(hookRun.coverage.child_lifecycle, /Delegated-child lifecycle events were observed/);
  assert.match(hookRun.coverage.witnessing_boundary, /Witnessing began at the hook-observed invocation/);
  // Fix 3: the hook branch carries the earlier-activity caveat on its face, like the non-hook branch.
  assert.match(hookRun.coverage.witnessing_boundary, /any session activity before that invocation was not observed/);
  assert.match(agentReported.coverage.witnessing_boundary, /was not observed/);
});

// CZ-12: a new run's record shows an OPEN predecessor without any intent judgment.
test('a new run surfaces a prior OPEN run in the same session observationally', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const sessionId = 'cz12-session';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const first = beginRun(parent, { mode: 'full', objective: 'First run, left open.' });
  // Simulate an orphaned active pointer (e.g., a cleared active/ dir) while the run stays OPEN.
  rmSync(join(data, 'active', `${sha256(parent)}.json`), { force: true });
  const second = beginRun(parent, { mode: 'full', objective: 'Second run begins.' });
  assert.notEqual(second.id, first.id);
  assert.equal(second.open_predecessors.length, 1);
  assert.equal(second.open_predecessors[0].run_id, first.id);
  assert.equal(second.open_predecessors[0].last_event_seq, first.ledger_count);
  const begun = getRunForTesting(second.id).events.find((event) => event.type === 'run_begun');
  assert.equal(begun.payload.open_predecessors[0].run_id, first.id);
  // Vocabulary is strictly observational — never "abandoned" or any intent judgment.
  const receipt = buildReceipt(getRunForTesting(second.id).state, getRunForTesting(second.id).events);
  assert.equal(receipt.open_predecessors.length, 1);
  assert.match(receipt.open_predecessors[0].statement, /was OPEN with no close request when this run began/);
  const markdown = renderReceiptMarkdown(getRunForTesting(second.id).state, getRunForTesting(second.id).events);
  assert.match(markdown, /## Prior open runs in this session/);
  assert.match(markdown, /was OPEN with no close request/);
  assert(!/abandon/i.test(markdown));
});

// CZ-12: begin_run idempotently re-attaches to a still-open run (the field's resume behavior),
// so no predecessor is fabricated when the active pointer is intact.
test('begin_run re-attaches to a still-open run without surfacing a predecessor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz12-reattach';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const first = beginRun(parent, { mode: 'full', objective: 'First.' });
  const second = beginRun(parent, { mode: 'full', objective: 'Resume.' });
  assert.equal(second.id, first.id, 'begin_run re-attaches to the still-open run rather than forking');
  assert.equal((second.open_predecessors || []).length, 0);
});

// CZ-11: a syntactically plausible but unknown capability records a value-free rejected-claim trace.
test('an unmappable rejected capability leaves a content-free claim-rejected marker', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const service = createService();
  const fabricated = `lyhna_session_${'a'.repeat(48)}`;
  return service.call('record_claim', { session_capability: fabricated, statement: 'I hold this capability.' }).then(
    () => assert.fail('expected UNKNOWN_CAPABILITY'),
    (error) => {
      assert.equal(error.code, 'UNKNOWN_CAPABILITY');
      const markers = readdirSync(join(data, 'claim-rejected'));
      assert.equal(markers.length, 1);
      const marker = JSON.parse(readFileSync(join(data, 'claim-rejected', markers[0]), 'utf8'));
      assert.equal(marker.code, 'UNKNOWN_CAPABILITY');
      assert.equal(marker.capability_kind, 'session');
      // Fix 5c: the marker carries error code + capability kind only — no ref inside the content.
      assert.equal(marker.ref, undefined);
      // The ref survives only as the filename prefix, never as correlatable content.
      assert.equal(markers[0], `claim-${sha256(fabricated).slice(0, 16)}.json`);
      // Content-free: the statement text never persists.
      assert(!JSON.stringify(marker).includes('I hold this capability'));
    }
  );
});

// CZ-11: a rejected capability that still maps to an OPEN run records the trace in that run.
test('a rejected capability mapping to an open run records a value-free claim_rejected event', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const sessionId = 'cz11-mapped';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Open run for a rejected re-claim.' });
  // Orphan the capability record but keep the active pointer and the open run.
  rmSync(join(data, 'capabilities', `${sha256(parent)}.json`), { force: true });
  recordRejectedClaim(parent);
  const events = getRunForTesting(run.id).events;
  const rejected = events.filter((event) => event.type === 'claim_rejected');
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].payload, { code: 'UNKNOWN_CAPABILITY', capability_kind: 'session' });
  // Idempotent: a repeated identical rejection collapses.
  recordRejectedClaim(parent);
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'claim_rejected').length, 1);
});

// CZ-11: a token that is not capability-shaped is never treated as a claim (distinguishes "never claimed").
test('a non-capability token records no rejected-claim trace', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  assert.equal(recordRejectedClaim('not-a-capability-token'), null);
  assert(!existsSync(join(data, 'claim-rejected')));
});

// Fix 5a: rejected-claim marker files stop accumulating at the deterministic limit (mirrors the miss cap).
test('rejected-claim markers stop accumulating at the deterministic limit', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  for (let index = 0; index < 40; index += 1) {
    recordRejectedClaim(`lyhna_session_${sha256(String(index))}`);
  }
  const markers = readdirSync(join(data, 'claim-rejected'));
  assert.equal(markers.length, 32);
});

// Fix 1: rung 3 stays constant even when a later evaluation records blocking-sounding finding text.
test('rung 3 stays "Not established" even when a later head records a blocking-sounding finding', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'rung3-constant';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Two heads; later head records a blocker.' });
  // First head: a benign evaluation.
  evaluateSnapshot(sessionId, parent, { ...stableSnapshot, id: 'pr_head_a', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-a');
  // Second head: an evaluation whose finding text sounds blocking; rung 3 must not be moved by it.
  const snapshotB = { ...stableSnapshot, id: 'pr_head_b', head_before: HEAD_B, head_after: HEAD_B, trigger: 'post_fix_reeval' };
  addPrSnapshot(parent, snapshotB);
  const evaluationB = beginEvaluation(parent, snapshotB.id, { head: HEAD_B, clean: true, detached: true, path: 'fixture-b' }, snapshotB.trigger);
  const childB = mintChild({ sessionId, agentId: 'evaluator-b' });
  claimEvaluation(childB, evaluationB.id);
  recordEvaluation(childB, evaluationB.id, 'BLOCKING: a critical defect must be fixed before merge.', [], {
    head_before: HEAD_B, head_after: HEAD_B, clean_before: true, clean_after: true, detached_before: true, detached_after: true
  });
  const receiptB = sealChildByAgent({ sessionId, agentId: 'evaluator-b' });
  readSealedReceipt(parent, receiptB.id);
  markSnapshotRefreshed(parent, snapshotB.id, HEAD_B);
  requestClose(parent, 'Close the run.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');

  const { state, events } = getRunForTesting(run.id);
  const receipt = buildReceipt(state, events);
  const chain = receipt.pr_head_chains[0];
  for (const head of chain.heads) {
    assert.equal(head.ladder.findings_addressed, 'Not established by this record.');
  }
  // The blocking-sounding later evaluation surfaces only as a plain observation, never "addressed".
  assert.equal(chain.heads[0].ladder.later_reevaluations.length, 1);
  const note = chain.heads[0].ladder.later_reevaluations[0];
  assert.equal(note.head, HEAD_B);
  assert.equal(note.trigger, 'post_fix_reeval');
  assert.match(note.statement, /a later evaluation at head .* was recorded/i);
  assert(!/address|fixed|resolved/i.test(note.statement));
  // The markdown rung-3 line is likewise constant; no "addressed/fixed/resolved" claim near the note.
  const markdown = renderReceiptMarkdown(state, events);
  assert.match(markdown, /Findings addressed: Not established by this record\./);
  assert(!/Later re-evaluations:[^\n]*(address|fixed|resolved)/i.test(markdown));
});
