import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareEvaluatorCheckout, snapshotPr } from '../src/github.mjs';

function runnerWithHeads(beforeHead, afterHead) {
  return (_command, args) => {
    const joined = args.join(' ');
    if (joined.includes('/pulls/7/comments')) return JSON.stringify([{ id: 1, body: 'github_pat_secret_should_not_leak', user: { login: 'reviewer' }, path: 'src/a.js' }]);
    if (joined.includes('/issues/7/comments')) return JSON.stringify([{ id: 2, body: 'full issue body', user: { login: 'owner' } }]);
    if (joined.endsWith('--json headRefOid')) return JSON.stringify({ headRefOid: afterHead });
    return JSON.stringify({
      number: 7,
      url: 'https://github.com/Lyhna-ai/example/pull/7',
      title: 'Adapter change',
      state: 'OPEN',
      isDraft: true,
      baseRefOid: 'b'.repeat(40),
      headRefOid: beforeHead,
      files: [{ path: 'src/a.js', additions: 1, deletions: 0 }],
      statusCheckRollup: [{ name: 'test', state: 'SUCCESS' }],
      reviews: [{ body: 'full review body', state: 'COMMENTED', author: { login: 'reviewer' }, commit: { oid: beforeHead } }]
    });
  };
}

test('GitHub snapshot retains structural metadata but not bodies', () => {
  const head = 'a'.repeat(40);
  const snapshot = snapshotPr({ repository: 'Lyhna-ai/example', prNumber: 7, runner: runnerWithHeads(head, head) });
  assert.equal(snapshot.status, 'CONSISTENT');
  const serialized = JSON.stringify(snapshot);
  assert(!serialized.includes('github_pat_secret_should_not_leak'));
  assert(!serialized.includes('full issue body'));
  assert(!serialized.includes('full review body'));
  assert.equal(snapshot.review_comments[0].body_ref.sha256.length, 64);
});

test('head drift during capture is inconsistent', () => {
  const snapshot = snapshotPr({ repository: 'Lyhna-ai/example', prNumber: 7, runner: runnerWithHeads('a'.repeat(40), 'c'.repeat(40)) });
  assert.equal(snapshot.status, 'INCONSISTENT_SNAPSHOT');
});

test('evaluator checkout rejects a source repository mismatch before fetching', () => {
  const calls = [];
  const runner = (_command, args) => {
    calls.push(args);
    if (args.join(' ') === 'remote get-url origin') return 'https://github.com/Lyhna-ai/not-the-requested-repo.git';
    throw new Error('unexpected command');
  };
  assert.throws(() => prepareEvaluatorCheckout({
    sourceCwd: 'fixture-source',
    destination: 'fixture-destination',
    head: 'a'.repeat(40),
    repository: 'Lyhna-ai/example',
    runner
  }), /SOURCE_REPOSITORY_MISMATCH/);
  assert.equal(calls.length, 1);
});
