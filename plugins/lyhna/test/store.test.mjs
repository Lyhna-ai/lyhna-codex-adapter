import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  addPrSnapshot,
  beginEvaluation,
  beginRun,
  checkpointOrSeal,
  claimEvaluation,
  getRunForTesting,
  listChildReceipts,
  markSnapshotRefreshed,
  mintChild,
  mintSession,
  readLedger,
  readSealedReceipt,
  rememberInvocation,
  recordClaim,
  recordEvaluation,
  recordHookForParent,
  requestClose,
  sealChildByAgent
} from '../src/store.mjs';
import { sanitizeHook } from '../src/redact.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

test('capabilities are hook-bound, isolated, and parent cannot self-review', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'session-a', cwd: process.cwd() });
  assert.equal(mintSession({ sessionId: 'session-a', cwd: process.cwd() }), parent);
  assert.notEqual(mintSession({ sessionId: 'session-b', cwd: process.cwd() }), parent);
  const run = beginRun(parent, { mode: 'full', objective: 'Build the requested feature.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  assert.throws(() => claimEvaluation(parent, evaluation.id), /CHILD_CAPABILITY_REQUIRED/);
  const siblingSession = mintSession({ sessionId: 'session-c', cwd: process.cwd() });
  beginRun(siblingSession, { mode: 'full', objective: 'Other run' });
  const sibling = mintChild({ sessionId: 'session-c', agentId: 'agent-sibling' });
  assert.throws(() => claimEvaluation(sibling, evaluation.id), /EVALUATION_NOT_FOUND/);
  const child = mintChild({ sessionId: 'session-a', agentId: 'agent-evaluator' });
  const claimed = claimEvaluation(child, evaluation.id);
  assert.equal(claimed.child_agent_hash.length, 64);
  assert.throws(() => claimEvaluation(child, evaluation.id), /EVALUATION_ALREADY_CLAIMED/);
  assert.equal(getRunForTesting(run.id).state.evaluations[evaluation.id].status, 'CLAIMED');
});

test('full run distinguishes hook evidence and seals only after evaluator receipt retrieval', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'parent-session', cwd: process.cwd() });
  const state = beginRun(parent, { mode: 'full', objective: 'Implement exact-head evaluation.' });

  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'call-1' }), 'pre-1');
  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'call-1', status: 'failed' }), 'post-1');
  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PermissionRequest', tool_name: 'exec_command', event_id: 'perm-1' }), 'perm-1');
  recordClaim(parent, 'The feature is complete.', []);
  assert.equal(checkpointOrSeal(parent).status, 'CHECKPOINTED');

  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'parent-session', agentId: 'evaluator-agent' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Seeded requirement mismatch remains.', ['test:seeded-mismatch'], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true
  });
  requestClose(parent, 'Evaluation recorded.');
  assert.equal(checkpointOrSeal(parent).status, 'CLOSE_DEFERRED');
  const childReceipt = sealChildByAgent({ sessionId: 'parent-session', agentId: 'evaluator-agent' });
  assert.equal(childReceipt.status, 'RECORDED');
  const childOriginal = readFileSync(childReceipt.path, 'utf8');
  writeFileSync(childReceipt.path, childOriginal.replace('RECORDED', 'ALTERED'));
  assert.throws(() => readSealedReceipt(parent, childReceipt.id), /LOCAL_CHAIN_BROKEN/);
  writeFileSync(childReceipt.path, childOriginal);
  assert.equal(listChildReceipts(parent).length, 1);
  assert.equal(checkpointOrSeal(parent).status, 'CLOSE_DEFERRED');
  readSealedReceipt(parent, childReceipt.id);
  const sealed = checkpointOrSeal(parent);
  assert.equal(sealed.status, 'SEALED');

  const receipt = readFileSync(join(getRunForTesting(state.id).directory, 'receipt.json'), 'utf8');
  const parsed = JSON.parse(receipt);
  assert.equal(parsed.status, 'SEALED');
  assert.equal(parsed.evaluations[0].child_receipt_retrieved, true);
  const labels = parsed.evidence.map((event) => event.label);
  assert(labels.includes('attempt_observed'));
  assert(labels.includes('tool_returned'));
  assert(labels.includes('permission_observed_not_execution'));
  assert(parsed.evidence.some((event) => event.origin === 'agent_reported'));
  assert(parsed.evidence.some((event) => event.origin === 'evaluator_reported'));
  assert.throws(() => recordClaim(parent, 'late mutation', []), /RUN_SEALED|RUN_ALREADY_SEALED/);
  assert.equal(readLedger(state.id, { allowOpen: false }).length, parsed.evidence.length);
});

test('sealed state and rendered receipt tampering are detected', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'artifact-tamper', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Bind rendered artifacts.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'artifact-tamper', agentId: 'artifact-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Examined.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true });
  const childReceipt = sealChildByAgent({ sessionId: 'artifact-tamper', agentId: 'artifact-evaluator' });
  readSealedReceipt(parent, childReceipt.id);
  requestClose(parent, 'Close.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');
  const directory = getRunForTesting(run.id).directory;
  const childPath = childReceipt.path;
  const childOriginal = readFileSync(childPath, 'utf8');
  writeFileSync(childPath, `${childOriginal}\nlocal alteration\n`);
  assert.throws(() => checkpointOrSeal(parent), /LOCAL_CHAIN_BROKEN/);
  assert.throws(() => readSealedReceipt(parent, childReceipt.id), /LOCAL_CHAIN_BROKEN/);
  writeFileSync(childPath, childOriginal);
  assert.equal(readSealedReceipt(parent, childReceipt.id).id, childReceipt.id);
  for (const [name, alter] of [
    ['state.json', (text) => {
      const value = JSON.parse(text);
      value.objective = `${value.objective} altered`;
      return `${JSON.stringify(value, null, 2)}\n`;
    }],
    ['receipt.json', (text) => text.replace('"status": "SEALED"', '"status": "ALTERED"')],
    ['RECEIPT.md', (text) => `${text}\nlocal alteration\n`]
  ]) {
    const path = join(directory, name);
    const original = readFileSync(path, 'utf8');
    const changed = alter(original);
    assert.notEqual(changed, original);
    writeFileSync(path, changed);
    assert.throws(() => checkpointOrSeal(parent), /LOCAL_CHAIN_BROKEN/);
    writeFileSync(path, original);
  }
});

test('stale lock ownership is recovered and free-form credentials never persist', { concurrency: false }, (t) => {
  const root = isolatedData(t);
  const rawPrompt = '@lyhna build the private customer feature password=hunter2 Authorization: Basic dXNlcjpwYXNz without copying this full prompt';
  rememberInvocation({ sessionId: 'privacy-lock', prompt: rawPrompt });
  const parent = mintSession({ sessionId: 'privacy-lock', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'password=hunter2' });
  const directory = getRunForTesting(run.id).directory;
  const lock = join(directory, '.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483646, acquired_at: '2000-01-01T00:00:00.000Z' }));
  recordClaim(parent, 'Password password=hunter2 Authorization: Basic dXNlcjpwYXNz', ['token=hunter2']);
  requestClose(parent, 'password=hunter2');

  const texts = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) visit(childPath);
      else if (entry.name !== 'master.key') texts.push(readFileSync(childPath, 'utf8'));
    }
  };
  visit(root);
  const all = texts.join('\n');
  assert(!all.includes('hunter2'));
  assert(!all.includes('dXNlcjpwYXNz'));
  assert(!all.includes(rawPrompt));
  assert(all.includes('Invocation objective retained by hash'));
  assert(!all.includes('private customer feature'));
});

test('dirty evaluator tree is an explicit integrity exception', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'dirty-parent', cwd: process.cwd() });
  beginRun(parent, { mode: 'full', objective: 'Check dirty state.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'dirty-parent', agentId: 'dirty-evaluator' });
  claimEvaluation(child, evaluation.id);
  const result = recordEvaluation(child, evaluation.id, 'Finding from modified tree.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: false
  });
  assert.equal(result.status, 'CHECKOUT_INTEGRITY_EXCEPTION');
});

test('inconsistent snapshots are blocked and explicit refresh marks prior work stale', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'stale-parent', cwd: process.cwd() });
  beginRun(parent, { mode: 'full', objective: 'Check head drift.' });
  addPrSnapshot(parent, { ...stableSnapshot, id: 'bad', head_after: 'c'.repeat(40), status: 'INCONSISTENT_SNAPSHOT' });
  assert.throws(() => beginEvaluation(parent, 'bad'), /INCONSISTENT_SNAPSHOT/);
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'stale-parent', agentId: 'stale-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Exact-head finding.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true
  });
  const refresh = markSnapshotRefreshed(parent, stableSnapshot.id, 'd'.repeat(40));
  assert.equal(refresh.stale, true);
  const current = getRunForTesting(beginRun(parent, { mode: 'full' }).id).state;
  assert.equal(current.evaluations[evaluation.id].status, 'STALE');
  assert.equal(current.pr_snapshots[stableSnapshot.id].status, 'STALE');
});

test('ledger mutation, deletion, reordering, and sealed-tail truncation are detected', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'tamper-parent', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Tamper test.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'tamper-parent', agentId: 'tamper-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'No material mismatch.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true });
  const receipt = sealChildByAgent({ sessionId: 'tamper-parent', agentId: 'tamper-evaluator' });
  readSealedReceipt(parent, receipt.id);
  requestClose(parent, 'Done');
  checkpointOrSeal(parent);
  const ledger = join(getRunForTesting(run.id).directory, 'events.jsonl');
  const original = readFileSync(ledger, 'utf8');
  const lines = original.trim().split('\n');
  const cases = [
    lines.map((line, index) => index === 1 ? line.replace('"seq":2', '"seq":22') : line),
    lines.filter((_line, index) => index !== 2),
    lines.map((line, index) => index === 1 ? lines[2] : index === 2 ? lines[1] : line),
    lines.slice(0, -1)
  ];
  for (const tampered of cases) {
    writeFileSync(ledger, `${tampered.join('\n')}\n`);
    assert.throws(() => readLedger(run.id), /LOCAL_CHAIN_BROKEN/);
    writeFileSync(ledger, original);
  }
});

test('open ledger tail and interrupted seal artifacts recover idempotently', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'recovery-parent', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Recovery test.' });
  recordClaim(parent, 'One durable claim.', []);
  const current = getRunForTesting(run.id);
  const statePath = join(current.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const prior = current.events.at(-2);
  state.ledger_count -= 1;
  state.ledger_tip = prior.event_hash;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.equal(readLedger(run.id).length, current.events.length);

  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'recovery-parent', agentId: 'recovery-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Recovery path examined.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true });
  const receipt = sealChildByAgent({ sessionId: 'recovery-parent', agentId: 'recovery-evaluator' });
  readSealedReceipt(parent, receipt.id);
  requestClose(parent, 'Close recovery test.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');
  rmSync(join(current.directory, 'seal-anchor.json'));
  rmSync(join(current.directory, 'receipt.json'));
  rmSync(join(current.directory, 'RECEIPT.md'));
  assert.equal(checkpointOrSeal(parent).status, 'ALREADY_SEALED');
  assert.doesNotThrow(() => readLedger(run.id, { allowOpen: false }));
});
