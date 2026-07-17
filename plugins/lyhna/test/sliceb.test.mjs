import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  sealChildByAgent,
  verifySealedRun
} from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { buildReceipt, renderReceiptMarkdown } from '../src/receipt.mjs';
import { canonicalJson, sha256 } from '../src/util.mjs';
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
// A retry arriving after record_evaluation but BEFORE the child receipt is sealed and retrieved
// must re-attach to the unfinished evaluation, not fork a second evaluator pass with new blockers.
test('a retry in the recording-to-retrieval gap re-attaches instead of forking', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'retry-gap';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  beginRun(parent, { mode: 'full', objective: 'Retry-gap run.' });
  const snapshot = { ...stableSnapshot, id: 'pr_gap', head_before: HEAD_A, head_after: HEAD_A };
  addPrSnapshot(parent, snapshot);
  const checkout = { head: HEAD_A, clean: true, detached: true, path: 'fixture-gap' };
  const first = beginEvaluation(parent, snapshot.id, checkout, 'initial');
  const child = mintChild({ sessionId, agentId: 'gap-evaluator' });
  claimEvaluation(child, first.id);
  recordEvaluation(child, first.id, 'Finding for the gap run.', [], {
    head_before: HEAD_A,
    head_after: HEAD_A,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  // RECORDED, receipt not yet sealed/read: begin_evaluation re-attaches, keeping the first trigger.
  const retry = beginEvaluation(parent, snapshot.id, checkout, 're_examination');
  assert.equal(retry.id, first.id);
  assert.equal(retry.trigger, 'initial');
  const receipt = sealChildByAgent({ sessionId, agentId: 'gap-evaluator' });
  readSealedReceipt(parent, receipt.id);
  // Sealed and retrieved: the evaluation is finished, so a fresh begin is a distinct re-examination.
  const second = beginEvaluation(parent, snapshot.id, checkout, 're_examination');
  assert.notEqual(second.id, first.id);
  assert.equal(second.trigger, 're_examination');
});

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

// Fix A (Codex review round 2): a re-examination of an unchanged PR head reaches begin_evaluation
// through the REAL tool path. snapshot_pr produces the same deterministic snapshot id both times, so
// the earlier snapshot-only de-dupe returned the first (terminal) evaluation and lost the second
// trigger. Now a fresh begin_evaluation on a terminal snapshot creates a distinct evaluation; a retry
// while one is still open re-attaches to it.
function fakeGithubRunner(head) {
  return (command, args) => {
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 7,
          url: 'https://github.com/Lyhna-ai/example/pull/7',
          title: 'Example PR',
          state: 'OPEN',
          isDraft: false,
          baseRefOid: 'b'.repeat(40),
          headRefOid: head,
          files: [{ path: 'src/example.mjs', additions: 2, deletions: 1, status: 'modified' }],
          statusCheckRollup: [{ name: 'test', state: 'SUCCESS', workflowName: 'CI' }],
          reviews: []
        });
      }
      if (args[0] === 'api') return JSON.stringify([]);
    }
    if (command === 'git') {
      if (args[0] === 'remote') return 'https://github.com/Lyhna-ai/example.git';
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return 'HEAD';
      if (args[0] === 'rev-parse') return head;
      return '';
    }
    return '';
  };
}

test('a re-examination at an unchanged head creates a distinct evaluation through the real tool path', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const service = createService({ githubRunner: fakeGithubRunner(HEAD_A) });
  const sessionId = 'same-head-reeval';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = await service.call('begin_run', { session_capability: parent, mode: 'full', objective: 'Re-examine the same head.' });

  const snap1 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  const eval1 = await service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: snap1.id, source_cwd: data, trigger: 'initial' });
  // Retry idempotency: repeating begin_evaluation while eval1 is still open returns the SAME
  // evaluation and keeps the first trigger — no duplicate, the later trigger is not adopted.
  const retry = await service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: snap1.id, source_cwd: data, trigger: 're_examination' });
  assert.equal(retry.id, eval1.id);
  assert.equal(retry.trigger, 'initial');

  // Complete eval1 (terminal RECORDED) via the real record path.
  const child1 = mintChild({ sessionId, agentId: 'evaluator-1' });
  await service.call('claim_evaluation', { child_capability: child1, evaluation_request_id: eval1.id });
  await service.call('record_evaluation', { child_capability: child1, evaluation_request_id: eval1.id, finding: 'First-pass finding.', checkout_head_before: HEAD_A, checkout_clean_before: true, checkout_detached_before: true });
  const receipt1 = sealChildByAgent({ sessionId, agentId: 'evaluator-1' });
  await service.call('read_sealed_receipt', { session_capability: parent, receipt_id: receipt1.id });

  // Snapshot the SAME head again: the deterministic id collides, exactly as the finding describes.
  const snap2 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  assert.equal(snap2.id, snap1.id);
  const eval2 = await service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: snap2.id, source_cwd: data, trigger: 're_examination' });
  // A distinct evaluation with its OWN trigger — the two same-head evaluations are now separable.
  assert.notEqual(eval2.id, eval1.id);
  assert.equal(eval2.trigger, 're_examination');

  const child2 = mintChild({ sessionId, agentId: 'evaluator-2' });
  await service.call('claim_evaluation', { child_capability: child2, evaluation_request_id: eval2.id });
  await service.call('record_evaluation', { child_capability: child2, evaluation_request_id: eval2.id, finding: 'Second-look finding.', checkout_head_before: HEAD_A, checkout_clean_before: true, checkout_detached_before: true });
  const receipt2 = sealChildByAgent({ sessionId, agentId: 'evaluator-2' });

  // The new evaluation blocks close until its own child receipt is retrieved.
  requestClose(parent, 'Close after re-examination.');
  const deferred = checkpointOrSeal(parent);
  assert.equal(deferred.status, 'CLOSE_DEFERRED');
  assert(deferred.blockers.includes(`CHILD_RECEIPT_${eval2.id}_NOT_RETRIEVED`));

  await service.call('read_sealed_receipt', { session_capability: parent, receipt_id: receipt2.id });
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');

  const { state, events } = getRunForTesting(run.run_id);
  const receipt = buildReceipt(state, events);
  // Both evaluations exist with their own triggers and both render on the receipt face.
  const triggers = receipt.evaluations.map((evaluation) => evaluation.trigger).sort();
  assert.deepEqual(triggers, ['initial', 're_examination']);
  const chain = receipt.pr_head_chains[0];
  assert.equal(chain.heads.length, 1);
  const renderedTriggers = chain.heads[0].ladder.independent_evaluation.map((item) => item.trigger).sort();
  assert.deepEqual(renderedTriggers, ['initial', 're_examination']);
  const markdown = renderReceiptMarkdown(state, events);
  assert.match(markdown, /trigger: `initial`/);
  assert.match(markdown, /trigger: `re_examination`/);
});

// Fix B (Codex review round 2): a snapshot at head H that went STALE (head moved away) and a later
// snapshot force-pushed BACK to H must render as two chain entries — the STALE predecessor and the
// CURRENT return — never merged into a single STALE entry that erases the one-CURRENT invariant.
test('a force-push return to the same SHA splits into a STALE predecessor and a CURRENT return', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'force-push-return';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Head left H and was force-pushed back to H.' });

  // Snapshot at H, then a refresh observes a different head H' — the snapshot goes STALE.
  const first = { ...stableSnapshot, id: 'pr_return_a', head_before: HEAD_A, head_after: HEAD_A };
  addPrSnapshot(parent, first);
  markSnapshotRefreshed(parent, first.id, HEAD_B);

  // Force-pushed back to H: a fresh snapshot at H, evaluated, then a post-evaluation refresh at H.
  const second = { ...stableSnapshot, id: 'pr_return_b', head_before: HEAD_A, head_after: HEAD_A };
  evaluateSnapshot(sessionId, parent, second, 'evaluator-return');
  markSnapshotRefreshed(parent, second.id, HEAD_A);

  requestClose(parent, 'Close the force-push-return run.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');

  const { state, events, directory } = getRunForTesting(run.id);
  const receipt = buildReceipt(state, events);
  assert.equal(receipt.pr_head_chains.length, 1);
  const chain = receipt.pr_head_chains[0];
  // Two entries for the SAME SHA — the head left and returned, so they must not merge.
  assert.equal(chain.heads.length, 2);
  assert.equal(chain.heads[0].head, HEAD_A);
  assert.equal(chain.heads[1].head, HEAD_A);
  const labels = chain.heads.map((head) => head.chain_label);
  assert.deepEqual(labels, ['STALE', 'CURRENT']);
  assert.equal(labels.filter((label) => label === 'CURRENT').length, 1);
  // The same-SHA later entry is described observationally, never as "a later head".
  assert.equal(chain.heads[0].ladder.later_reevaluations.length, 1);
  const note = chain.heads[0].ladder.later_reevaluations[0];
  assert.equal(note.head, HEAD_A);
  assert.match(note.statement, /a later observation of head/i);
  assert(!/a later head/i.test(note.statement));
  assert(!/address|fixed|resolved/i.test(note.statement));
  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  assert.match(markdown, /Head `aaaaaaaa.*: \*\*STALE\*\*/);
  assert.match(markdown, /Head `aaaaaaaa.*: \*\*CURRENT\*\*/);
});

// Fix 2: a run whose receipt files + anchor were produced by a DIFFERENT renderer reads and verifies
// cleanly (tamper evidence preserved via the stored hashes), rather than throwing LOCAL_CHAIN_BROKEN.
// A genuine pre-0.1.26 run has a run_sealed ledger event with no receipt_renderer in its payload,
// so the simulation rewrites the ledger tail with a valid chain — not just the anchor.
function simulateOldRendererRun(sessionId) {
  const snapshots = [{ ...stableSnapshot, id: 'pr_old', head_before: HEAD_A, head_after: HEAD_A }];
  const { parent, run } = sealMultiHeadRun({ sessionId, snapshots, refreshFinal: true });
  const directory = getRunForTesting(run.id).directory;
  const anchorFile = join(directory, 'seal-anchor.json');
  const stateFile = join(directory, 'state.json');
  const ledgerFile = join(directory, 'events.jsonl');
  const jsonFile = join(directory, 'receipt.json');
  const markdownFile = join(directory, 'RECEIPT.md');
  // Rewrite the final (run_sealed) ledger event to the pre-0.1.26 payload shape, recomputing
  // its hashes so the chain stays valid — this is what an old run's ledger actually contains.
  const lines = readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const sealEvent = JSON.parse(lines.at(-1));
  assert.equal(sealEvent.type, 'run_sealed');
  sealEvent.payload = { status: 'SEALED' };
  sealEvent.content_hash = sha256(canonicalJson({ origin: sealEvent.origin, payload: sealEvent.payload, type: sealEvent.type }));
  delete sealEvent.event_hash;
  sealEvent.event_hash = sha256(canonicalJson(sealEvent));
  lines[lines.length - 1] = canonicalJson(sealEvent);
  writeFileSync(ledgerFile, `${lines.join('\n')}\n`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.ledger_tip = sealEvent.event_hash;
  writeFileSync(stateFile, `${canonicalJson(state, true)}\n`);
  // Bytes an older renderer would have produced — different from the current renderer's output,
  // but the anchor commits to their hashes.
  const legacyJson = `${readFileSync(jsonFile, 'utf8')}\n{"legacy_renderer":true}\n`;
  const legacyMarkdown = `${readFileSync(markdownFile, 'utf8')}\nRendered by an older receipt renderer.\n`;
  writeFileSync(jsonFile, legacyJson);
  writeFileSync(markdownFile, legacyMarkdown);
  const anchor = JSON.parse(readFileSync(anchorFile, 'utf8'));
  delete anchor.receipt_renderer;
  anchor.final_hash = sealEvent.event_hash;
  anchor.state_hash = sha256(canonicalJson(state));
  anchor.receipt_json_hash = sha256(legacyJson);
  anchor.receipt_markdown_hash = sha256(legacyMarkdown);
  writeFileSync(anchorFile, `${JSON.stringify(anchor, null, 2)}\n`);
  return { parent, run, directory, markdownFile, legacyMarkdown };
}

test('a run sealed by an older renderer reads and verifies without re-render equality', { concurrency: false }, (t) => {
  isolatedData(t);
  const { parent, run } = simulateOldRendererRun('old-renderer-clean');
  // Verification does not re-render; it must NOT throw despite the current renderer diverging.
  assert.equal(verifySealedRun(run.id).status, 'ALREADY_SEALED');
  const childId = Object.keys(getRunForTesting(run.id).state.child_receipts)[0];
  assert.equal(readSealedReceipt(parent, childId).id, childId);
});

test('an older-renderer run whose receipt file was edited afterward still fails tamper detection', { concurrency: false }, (t) => {
  isolatedData(t);
  const { run, markdownFile, legacyMarkdown } = simulateOldRendererRun('old-renderer-tamper');
  writeFileSync(markdownFile, `${legacyMarkdown}local tampering\n`);
  assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// Deleting the anchor's informational receipt_renderer field must not downgrade a
// current-version run onto the weaker legacy path: the gate reads the hash-chained
// run_sealed event, so an anchor-plus-receipt edit is still detected.
test('anchor renderer-field deletion cannot downgrade verification of a current-version seal', { concurrency: false }, (t) => {
  isolatedData(t);
  const snapshots = [{ ...stableSnapshot, id: 'pr_downgrade', head_before: HEAD_A, head_after: HEAD_A }];
  const { run } = sealMultiHeadRun({ sessionId: 'downgrade-attack', snapshots, refreshFinal: true });
  const directory = getRunForTesting(run.id).directory;
  const anchorFile = join(directory, 'seal-anchor.json');
  const markdownFile = join(directory, 'RECEIPT.md');
  const edited = `${readFileSync(markdownFile, 'utf8')}\nedited after seal\n`;
  writeFileSync(markdownFile, edited);
  const anchor = JSON.parse(readFileSync(anchorFile, 'utf8'));
  delete anchor.receipt_renderer;
  anchor.receipt_markdown_hash = sha256(edited);
  writeFileSync(anchorFile, `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// Fix (Codex review round 3): the REAL snapshot_pr path. A force-push away from head H and back to H
// with unchanged sanitized metadata produces the SAME deterministic snapshot id. The pre-existing
// addPrSnapshot overwrote state.pr_snapshots[id] on re-add, resurrecting the STALE record back to
// CONSISTENT and collapsing the away-and-back into a single entry that renders one CURRENT — erasing
// the earlier STALE observation and its evaluation. The store now forks an occurrence-suffixed record
// on divergence (base -o2), so the round-2 chain split sees two records: STALE then CURRENT.
function mutableGithubRunner(headRef) {
  return (command, args) => {
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 7,
          url: 'https://github.com/Lyhna-ai/example/pull/7',
          title: 'Example PR',
          state: 'OPEN',
          isDraft: false,
          baseRefOid: 'b'.repeat(40),
          headRefOid: headRef.head,
          files: [{ path: 'src/example.mjs', additions: 2, deletions: 1, status: 'modified' }],
          statusCheckRollup: [{ name: 'test', state: 'SUCCESS', workflowName: 'CI' }],
          reviews: []
        });
      }
      if (args[0] === 'api') return JSON.stringify([]);
    }
    if (command === 'git') {
      if (args[0] === 'remote') return 'https://github.com/Lyhna-ai/example.git';
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return 'HEAD';
      if (args[0] === 'rev-parse') return headRef.head;
      return '';
    }
    return '';
  };
}

async function evaluateThroughService(service, { sessionId, parent, snapshotId, agentId, trigger, data }) {
  const evaluation = await service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: snapshotId, source_cwd: data, trigger });
  const child = mintChild({ sessionId, agentId });
  await service.call('claim_evaluation', { child_capability: child, evaluation_request_id: evaluation.id });
  await service.call('record_evaluation', { child_capability: child, evaluation_request_id: evaluation.id, finding: `Finding for ${snapshotId}.`, checkout_head_before: HEAD_A, checkout_clean_before: true, checkout_detached_before: true });
  const receipt = sealChildByAgent({ sessionId, agentId });
  await service.call('read_sealed_receipt', { session_capability: parent, receipt_id: receipt.id });
  return evaluation;
}

test('a force-push away-and-back through the real snapshot path forks a STALE-then-CURRENT occurrence', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const headRef = { head: HEAD_A };
  const service = createService({ githubRunner: mutableGithubRunner(headRef) });
  const sessionId = 'round3-forcepush-return';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = await service.call('begin_run', { session_capability: parent, mode: 'full', objective: 'Force-push away and back to H.' });

  // Observe at H, evaluate at H, then a refresh observes H' — the observation goes STALE.
  const snap1 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  const eval1 = await evaluateThroughService(service, { sessionId, parent, snapshotId: snap1.id, agentId: 'evaluator-1', trigger: 'initial', data });
  headRef.head = HEAD_B;
  const refresh1 = await service.call('refresh_pr', { session_capability: parent, pr_snapshot_id: snap1.id });
  assert.equal(refresh1.stale, true);

  // Force-pushed back to H: snapshot again with IDENTICAL metadata — the deterministic id collides.
  headRef.head = HEAD_A;
  const snap2 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  // A NEW occurrence record exists; the original STALE record and its evaluation are preserved untouched.
  assert.equal(snap2.id, `${snap1.id}-o2`);
  assert.notEqual(snap2.id, snap1.id);
  const afterFork = getRunForTesting(run.run_id).state;
  assert.equal(afterFork.pr_snapshots[snap1.id].status, 'STALE', 'the earlier observation stays STALE');
  assert.equal(afterFork.pr_snapshots[snap2.id].status, 'CONSISTENT', 'the returned observation is a fresh CONSISTENT record');
  assert.equal(Object.values(afterFork.evaluations).filter((item) => item.snapshot_id === snap1.id && item.id === eval1.id).length, 1);
  assert.equal(afterFork.evaluations[eval1.id].status, 'STALE', "the earlier evaluation is preserved and STALE");
  // Two distinct pr_snapshot ledger events (occurrence key did not dedupe against the first).
  const snapshotEvents = getRunForTesting(run.run_id).events.filter((event) => event.type === 'pr_snapshot');
  assert.deepEqual(snapshotEvents.map((event) => event.payload.id).sort(), [snap1.id, snap2.id].sort());

  // Evaluate the returned observation, then a post-evaluation refresh confirms it CURRENT at H.
  await evaluateThroughService(service, { sessionId, parent, snapshotId: snap2.id, agentId: 'evaluator-2', trigger: 're_examination', data });
  const refresh2 = await service.call('refresh_pr', { session_capability: parent, pr_snapshot_id: snap2.id });
  assert.equal(refresh2.stale, false);

  requestClose(parent, 'Close the force-push-return run.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');

  const { state, events, directory } = getRunForTesting(run.run_id);
  const receipt = buildReceipt(state, events);
  assert.equal(receipt.pr_head_chains.length, 1);
  const chain = receipt.pr_head_chains[0];
  // Two entries for the SAME SHA — STALE predecessor then CURRENT return, exactly one CURRENT.
  assert.equal(chain.heads.length, 2);
  assert.equal(chain.heads[0].head, HEAD_A);
  assert.equal(chain.heads[1].head, HEAD_A);
  const labels = chain.heads.map((head) => head.chain_label);
  assert.deepEqual(labels, ['STALE', 'CURRENT']);
  assert.equal(labels.filter((label) => label === 'CURRENT').length, 1);
  // The earlier evaluation is still attached to the STALE entry.
  assert.deepEqual(chain.heads[0].ladder.independent_evaluation.map((item) => item.evaluation_id), [eval1.id]);
  assert.equal(chain.heads[0].ladder.independent_evaluation[0].status, 'STALE');
  // The same-SHA later entry is described observationally, never as "a later head".
  assert.equal(chain.heads[0].ladder.later_reevaluations.length, 1);
  assert.match(chain.heads[0].ladder.later_reevaluations[0].statement, /a later observation of head/i);
  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  assert.match(markdown, /Head `aaaaaaaa.*: \*\*STALE\*\*/);
  assert.match(markdown, /Head `aaaaaaaa.*: \*\*CURRENT\*\*/);
});

// Fix (Codex review round 3): a plain retry — re-snapshot with NO divergence in between — stays
// idempotent: the same base id, no duplicate ledger event, and no status/field resurrection.
test('a plain re-snapshot with no divergence neither duplicates events nor resurrects state', { concurrency: false }, async (t) => {
  isolatedData(t);
  const headRef = { head: HEAD_A };
  const service = createService({ githubRunner: mutableGithubRunner(headRef) });
  const sessionId = 'round3-plain-retry';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = await service.call('begin_run', { session_capability: parent, mode: 'full', objective: 'Plain re-snapshot.' });

  const snap1 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  // A same-head refresh keeps the observation CURRENT and records current_head; not a divergence.
  const refresh = await service.call('refresh_pr', { session_capability: parent, pr_snapshot_id: snap1.id });
  assert.equal(refresh.stale, false);
  // Re-snapshot with identical metadata and no divergence: same id, an idempotent re-read.
  const snap2 = await service.call('snapshot_pr', { session_capability: parent, repository: 'Lyhna-ai/example', pr_number: 7 });
  assert.equal(snap2.id, snap1.id);

  const { state, events } = getRunForTesting(run.run_id);
  // Exactly one pr_snapshot event — the retry deduped rather than appending a second observation.
  assert.equal(events.filter((event) => event.type === 'pr_snapshot').length, 1);
  assert.equal(Object.keys(state.pr_snapshots).length, 1);
  // No resurrection or field loss: the record stays CONSISTENT and keeps its refresh-observed head.
  assert.equal(state.pr_snapshots[snap1.id].status, 'CONSISTENT');
  assert.equal(state.pr_snapshots[snap1.id].current_head, HEAD_A);
});
