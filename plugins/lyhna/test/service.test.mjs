import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '../src/service.mjs';
import { addPrSnapshot, beginRun, getRunForTesting, mintSession } from '../src/store.mjs';
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
    service.call('begin_evaluation', { session_capability: parent, pr_snapshot_id: stableSnapshot.id }),
    /CHECKOUT_PREPARATION_FAILED.*SOURCE_REPOSITORY_MISMATCH/
  );
  assert.deepEqual(getRunForTesting(run.id).state.evaluations, {});
});
