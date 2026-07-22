import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  readLedger,
  readSealedReceipt,
  recordClaim,
  recordEvaluation,
  requestClose,
  sealChildByAgent,
  verifyRun,
  verifySealedRun
} from '../src/store.mjs';
import { canonicalJson, sha256 } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

const HEAD_A = 'a'.repeat(40);

function readAnchor(directory) {
  return JSON.parse(readFileSync(join(directory, 'checkpoint-anchor.json'), 'utf8'));
}

// Drive a full run all the way to a seal, mirroring the established fixture flow.
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

// 1. A plain checkpoint (no close request) writes the anchor + receipts and the face reads OPEN.
test('a plain checkpoint writes an anchor and receipts, and the face reads OPEN', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-open';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'An open run reaching a Stop.' });
  const result = checkpointOrSeal(parent, 'stop-1');
  assert.equal(result.status, 'CHECKPOINTED');

  const { directory, events } = getRunForTesting(run.id);
  assert(existsSync(join(directory, 'checkpoint-anchor.json')));
  assert(existsSync(join(directory, 'receipt.json')));
  assert(existsSync(join(directory, 'RECEIPT.md')));

  const anchor = readAnchor(directory);
  assert.equal(anchor.run_id, run.id);
  assert.equal(anchor.as_of_seq, events.length);
  assert.equal(anchor.tip_hash, events.at(-1).event_hash);
  assert.equal(anchor.receipt_renderer, '0.1.27');
  assert.equal(anchor.receipt_json_hash, sha256(readFileSync(join(directory, 'receipt.json'), 'utf8')));
  assert.equal(anchor.receipt_markdown_hash, sha256(readFileSync(join(directory, 'RECEIPT.md'), 'utf8')));

  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.lifecycle.status, 'OPEN');
  assert.match(receipt.lifecycle.statement, /OPEN as of event \d+ — no close request observed\./);
  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  assert.match(markdown, /## Lifecycle/);
  assert.match(markdown, /Lifecycle status: \*\*OPEN\*\*/);
  assert.match(markdown, /OPEN as of event \d+ — no close request observed\./);
  // The renderer version is pinned in the hash-chained checkpoint event, not only in the anchor.
  assert.equal(events.at(-1).type, 'turn_checkpoint');
  assert.equal(events.at(-1).payload.receipt_renderer, '0.1.27');
  // Never an intent judgment.
  assert(!/abandon/i.test(markdown));
});

// 2. The B11 shape: a close was requested, the seal deferred by blockers, the run left open. The face
// states close-requested-not-sealed and lists the blockers as observations.
test('a close-deferred checkpoint face states close-requested-not-sealed and lists blockers', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-b11';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Close requested, seal deferred.' });
  requestClose(parent, 'Please close.');
  const deferred = checkpointOrSeal(parent, 'stop-1');
  assert.equal(deferred.status, 'CLOSE_DEFERRED');
  assert(deferred.blockers.includes('PR_SNAPSHOT_REQUIRED'));

  const { directory, events } = getRunForTesting(run.id);
  assert(existsSync(join(directory, 'checkpoint-anchor.json')));
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.lifecycle.status, 'CLOSE_REQUESTED_NOT_SEALED');
  const closeSeq = events.find((event) => event.type === 'close_requested').seq;
  assert.equal(receipt.lifecycle.close_requested_seq, closeSeq);
  assert.match(receipt.lifecycle.statement, new RegExp(`A close was requested at event ${closeSeq}; the run had not sealed as of this checkpoint`));
  assert(receipt.lifecycle.blockers_observed.some((blocker) => blocker.code === 'PR_SNAPSHOT_REQUIRED'));

  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  assert.match(markdown, /Lifecycle status: \*\*CLOSE_REQUESTED_NOT_SEALED\*\*/);
  assert.match(markdown, /A close was requested at event \d+; the run had not sealed as of this checkpoint/);
  assert.match(markdown, /Open closeout conditions observed as of this checkpoint:/);
  assert.match(markdown, /PR_SNAPSHOT_REQUIRED/);
  // Observational only — never "abandoned", never a permission verb.
  assert(!/abandon/i.test(markdown));
  assert(!/\b(approv|refus|block|escalat|certif)/i.test(receipt.lifecycle.statement));
  // The close_deferred event also pins the renderer in the ledger.
  assert.equal(events.at(-1).type, 'close_deferred');
  assert.equal(events.at(-1).payload.receipt_renderer, '0.1.27');
});

// 3. Open-packet verification passes on an untampered checkpoint packet.
test('verifyRun passes on an untampered open checkpoint packet', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-verify-clean';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Verify a clean open packet.' });
  checkpointOrSeal(parent, 'stop-1');
  const result = verifyRun(run.id);
  assert.equal(result.status, 'CHECKPOINT_VERIFIED');
  assert.equal(result.ledger_advanced, false);
  assert.equal(result.as_of_seq, getRunForTesting(run.id).events.length);
});

// 4a. Tamper: an edited ledger line fails closed.
test('an edited ledger line fails open-packet verification closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-tamper-ledger';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Ledger tamper.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const ledger = join(directory, 'events.jsonl');
  const original = readFileSync(ledger, 'utf8');
  const lines = original.trim().split('\n');
  writeFileSync(ledger, `${lines.map((line, index) => index === 0 ? line.replace('"seq":1', '"seq":11') : line).join('\n')}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 4b. Tamper: an edited receipt file (anchor untouched) fails closed.
test('an edited receipt file fails open-packet verification closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-tamper-receipt';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Receipt tamper.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const markdownFile = join(directory, 'RECEIPT.md');
  writeFileSync(markdownFile, `${readFileSync(markdownFile, 'utf8')}\nlocal tampering\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 4c. Tamper: deleting the anchor's receipt_renderer must NOT select a weaker path — the ledger pins
// the gate, so an anchor-plus-receipt edit is still detected by the re-render reproduction check.
test('deleting the anchor receipt_renderer cannot downgrade open-packet verification', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-downgrade';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Downgrade attack.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const anchorFile = join(directory, 'checkpoint-anchor.json');
  const markdownFile = join(directory, 'RECEIPT.md');
  const edited = `${readFileSync(markdownFile, 'utf8')}\nedited after checkpoint\n`;
  writeFileSync(markdownFile, edited);
  const anchor = JSON.parse(readFileSync(anchorFile, 'utf8'));
  delete anchor.receipt_renderer;
  anchor.receipt_markdown_hash = sha256(edited);
  writeFileSync(anchorFile, `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 4d. Tamper: an anchor pointing past the ledger fails closed.
test('an anchor pointing past the ledger fails open-packet verification closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-anchor-past';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Anchor past ledger.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const anchorFile = join(directory, 'checkpoint-anchor.json');
  const anchor = JSON.parse(readFileSync(anchorFile, 'utf8'));
  anchor.as_of_seq += 5;
  writeFileSync(anchorFile, `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 5. The ledger legitimately advances past the anchor (an event appended after the last Stop). Verify
// still passes chain + file-hash checks; state-hash equality and re-render do not apply.
test('verifyRun still passes when the ledger has advanced past the checkpoint anchor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-advanced';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Advance past the anchor.' });
  checkpointOrSeal(parent, 'stop-1');
  const anchorSeq = readAnchor(getRunForTesting(run.id).directory).as_of_seq;
  // A builder claim appended after the checkpoint advances the ledger without rewriting the receipt.
  recordClaim(parent, 'Work continued after the checkpoint.', []);
  const advanced = getRunForTesting(run.id);
  assert(advanced.events.length > anchorSeq);
  const result = verifyRun(run.id);
  assert.equal(result.status, 'CHECKPOINT_VERIFIED');
  assert.equal(result.ledger_advanced, true);
  assert.equal(result.as_of_seq, anchorSeq);
});

// 6. Seal after checkpoints: the sealed packet verifies exactly as before, and the checkpoint anchor
// is removed at seal so the sealed run carries exactly one anchor (the seal anchor).
test('a run sealed after checkpoints drops the checkpoint anchor and verifies as a sealed run', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-seal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Checkpoint then seal.' });
  // A Stop before any close leaves a checkpoint anchor on disk.
  checkpointOrSeal(parent, 'stop-1');
  assert(existsSync(join(getRunForTesting(run.id).directory, 'checkpoint-anchor.json')));

  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_seal', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-seal');
  requestClose(parent, 'Close after evaluation.');
  assert.equal(checkpointOrSeal(parent, 'stop-2').status, 'SEALED');

  const { directory } = getRunForTesting(run.id);
  // Exactly one anchor: the seal anchor remains, the checkpoint anchor is gone.
  assert(existsSync(join(directory, 'seal-anchor.json')));
  assert(!existsSync(join(directory, 'checkpoint-anchor.json')));
  // The sealed packet verifies through the unchanged sealed path, via both entry points.
  assert.equal(verifySealedRun(run.id).status, 'ALREADY_SEALED');
  assert.equal(verifyRun(run.id).status, 'ALREADY_SEALED');
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.lifecycle.status, 'SEALED');
  assert.equal(receipt.status, 'SEALED');
});

// 7. A legacy open run with no checkpoint anchor reads and verifies with unchanged behavior: a
// structural result, never a raw Node throw.
test('a legacy open run with no checkpoint anchor reads and verifies unchanged', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-legacy';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Legacy open shape.' });
  recordClaim(parent, 'A claim with no Stop yet.', []);
  const { directory, events } = getRunForTesting(run.id);
  assert(!existsSync(join(directory, 'checkpoint-anchor.json')));
  // readLedger behavior is unchanged for an open run.
  assert.equal(readLedger(run.id).length, events.length);
  // verifyRun returns a structural result rather than throwing.
  const result = verifyRun(run.id);
  assert.equal(result.status, 'OPEN_NO_CHECKPOINT');
  assert.equal(result.event_count, events.length);
});

// A deduped checkpoint (same delivery key on a second Stop) still leaves a correct, idempotent anchor.
test('a deduped checkpoint re-writes an identical anchor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-dedupe';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Deduped checkpoint.' });
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CHECKPOINTED');
  const first = readAnchor(getRunForTesting(run.id).directory);
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CHECKPOINTED');
  const { directory, events } = getRunForTesting(run.id);
  // The duplicate delivery key did not append a second checkpoint event.
  assert.equal(events.filter((event) => event.type === 'turn_checkpoint').length, 1);
  // The anchor is byte-identical after the deduped Stop.
  assert.equal(canonicalJson(readAnchor(directory)), canonicalJson(first));
  assert.equal(verifyRun(run.id).status, 'CHECKPOINT_VERIFIED');
});
