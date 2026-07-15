import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '../src/service.mjs';
import { addPrSnapshot, beginRun, getRunForTesting, mintChild, mintSession } from '../src/store.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

test('checkout preparation failure does not create an evaluation', { concurrency: false }, async (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'checkout-failure', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Review exact head.' });
  addPrSnapshot(parent, stableSnapshot);
  const service = createService({
    githubRunner: (_command, args) => {
      if (args.join(' ') === 'remote get-url origin') return 'https://github.com/Lyhna-ai/wrong-repo.git';
      throw new Error(`unexpected command ${args.join(' ')}`);
    }
  });
  await assert.rejects(
    service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: stableSnapshot.id, source_cwd: process.cwd() }),
    /CHECKOUT_PREPARATION_FAILED.*SOURCE_REPOSITORY_MISMATCH/
  );
  assert.deepEqual(getRunForTesting(run.id).state.evaluations, {});
});

test('managed evaluation preserves the evaluator before-check and re-inspects detached after-state', { concurrency: false }, async (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'managed-before', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Preserve evaluator observations.' });
  addPrSnapshot(parent, stableSnapshot);
  const runner = (_command, args) => {
    const joined = args.join(' ');
    if (joined === 'remote get-url origin') return 'https://github.com/Lyhna-ai/example.git';
    if (joined.startsWith('cat-file -e ')) return '';
    if (joined.startsWith('worktree add --detach ')) return '';
    if (joined === 'rev-parse HEAD') return stableSnapshot.head_after;
    if (joined === 'status --porcelain --untracked-files=no') return '';
    if (joined === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
    throw new Error(`unexpected command ${joined}`);
  };
  const service = createService({ githubRunner: runner });
  const evaluation = await service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: stableSnapshot.id, source_cwd: process.cwd() });
  assert.equal(typeof evaluation.checkout_path, 'string');
  const durableEvaluation = getRunForTesting(run.id).state.evaluations[evaluation.id];
  assert.equal(durableEvaluation.checkout_path, undefined);
  assert.equal(durableEvaluation.checkout_path_ref.sha256.length, 64);
  const child = mintChild({ sessionId: 'managed-before', agentId: 'managed-evaluator' });
  await service.call('claim_evaluation', { child_capability: child, evaluation_request_id: evaluation.id });
  const recorded = await service.call('record_evaluation', {
    child_capability: child,
    evaluation_request_id: evaluation.id,
    finding: 'Before-check mismatch retained.',
    checkout_head_before: 'b'.repeat(40),
    checkout_clean_before: false,
    checkout_detached_before: false
  });
  assert.equal(recorded.status, 'CHECKOUT_INTEGRITY_EXCEPTION');
  const stored = getRunForTesting(run.id).state.evaluations[evaluation.id];
  assert.equal(stored.checkout_head_before, 'b'.repeat(40));
  assert.equal(stored.checkout_clean_before, false);
  assert.equal(stored.checkout_detached_before, false);
  assert.equal(stored.checkout_head_after, stableSnapshot.head_after);
  assert.equal(stored.checkout_clean_after, true);
  assert.equal(stored.checkout_detached_after, true);
});
