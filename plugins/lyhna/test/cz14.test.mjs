import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // The ledger commits the checkpoint: the terminal event is the hash-chained checkpoint_anchor
  // covering everything before it, and the anchor file agrees with it.
  const anchorEvent = events.at(-1);
  assert.equal(anchorEvent.type, 'checkpoint_anchor');
  assert.equal(anchorEvent.payload.covers_seq, events.length - 1);
  assert.equal(anchorEvent.payload.receipt_renderer, '0.1.27');
  assert.equal(anchorEvent.payload.receipt_json_hash, sha256(readFileSync(join(directory, 'receipt.json'), 'utf8')));
  assert.equal(anchorEvent.payload.receipt_markdown_hash, sha256(readFileSync(join(directory, 'RECEIPT.md'), 'utf8')));
  const anchor = readAnchor(directory);
  assert.equal(anchor.run_id, run.id);
  assert.equal(anchor.as_of_seq, events.length - 1);
  assert.equal(anchor.anchor_event_seq, anchorEvent.seq);
  assert.equal(anchor.tip_hash, events.at(-2).event_hash);
  assert.equal(anchor.receipt_renderer, '0.1.27');
  assert.equal(anchor.receipt_json_hash, anchorEvent.payload.receipt_json_hash);
  assert.equal(anchor.receipt_markdown_hash, anchorEvent.payload.receipt_markdown_hash);

  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.lifecycle.status, 'OPEN');
  assert.match(receipt.lifecycle.statement, /OPEN as of event \d+ — no close request observed\./);
  const markdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  assert.match(markdown, /## Lifecycle/);
  assert.match(markdown, /Lifecycle status: \*\*OPEN\*\*/);
  assert.match(markdown, /OPEN as of event \d+ — no close request observed\./);
  // The checkpoint event itself precedes its anchor in the ledger.
  assert.equal(events.at(-2).type, 'turn_checkpoint');
  assert.equal(events.at(-2).payload.receipt_renderer, '0.1.27');
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
  // The deferred close is itself a checkpoint: close_deferred, then its hash-chained anchor.
  assert.equal(events.at(-2).type, 'close_deferred');
  assert.equal(events.at(-2).payload.receipt_renderer, '0.1.27');
  assert.equal(events.at(-1).type, 'checkpoint_anchor');
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
  assert.equal(result.files_match_latest_anchor, true);
  assert.equal(result.as_of_seq, getRunForTesting(run.id).events.length - 1);
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

// 4c. Tamper: editing the mutable anchor file (deleting receipt_renderer, re-pointing hashes) must
// NOT select a weaker path — the hashes live in the hash-chained checkpoint_anchor event, so the
// edited file disagrees with the ledger and the edited receipt matches no ledger-committed bytes.
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
  // The duplicate delivery key appended neither a second checkpoint event nor a second anchor
  // event (the terminal event was already the anchor — re-anchoring would anchor the anchor).
  assert.equal(events.filter((event) => event.type === 'turn_checkpoint').length, 1);
  assert.equal(events.filter((event) => event.type === 'checkpoint_anchor').length, 1);
  // The anchor is byte-identical after the deduped Stop.
  assert.equal(canonicalJson(readAnchor(directory)), canonicalJson(first));
  assert.equal(verifyRun(run.id).status, 'CHECKPOINT_VERIFIED');
});

// 8 (review F1). Forging the receipt files AND the mutable anchor file after the ledger has advanced
// must still fail closed: the receipt bytes are committed to the hash-chained checkpoint_anchor
// event, which the forger cannot rewrite without breaking the chain.
test('a forged receipt plus forged anchor file fails closed after the ledger advances', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-forge-advanced';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Forge after advance.' });
  checkpointOrSeal(parent, 'stop-1');
  recordClaim(parent, 'Work continued after the checkpoint.', []);
  const { directory } = getRunForTesting(run.id);
  const forgedJson = `${readFileSync(join(directory, 'receipt.json'), 'utf8')}\n{"FORGED":true}\n`;
  const forgedMarkdown = `${readFileSync(join(directory, 'RECEIPT.md'), 'utf8')}\nAll findings addressed and approved.\n`;
  writeFileSync(join(directory, 'receipt.json'), forgedJson);
  writeFileSync(join(directory, 'RECEIPT.md'), forgedMarkdown);
  const anchor = readAnchor(directory);
  anchor.receipt_json_hash = sha256(forgedJson);
  anchor.receipt_markdown_hash = sha256(forgedMarkdown);
  writeFileSync(join(directory, 'checkpoint-anchor.json'), `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 9 (review F2). The B11 dedupe shape: close deferred with an unchanged blocker set on a later Stop
// after intervening events. The renderer gate and receipt hashes come from the fresh checkpoint_anchor
// event, so verification stays fully gated and a forged receipt still fails closed.
test('a re-deferred close after intervening events stays fully verifiable and forge-proof', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-dedupe-deferred';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Deferred close with intervening events.' });
  requestClose(parent, 'Please close.');
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CLOSE_DEFERRED');
  recordClaim(parent, 'An intervening claim between two deferred Stops.', []);
  assert.equal(checkpointOrSeal(parent, 'stop-2').status, 'CLOSE_DEFERRED');

  const { directory, events } = getRunForTesting(run.id);
  // The unchanged blocker set appended no second close_deferred, but the second Stop anchored the
  // advanced ledger with a fresh checkpoint_anchor event carrying the renderer gate.
  assert.equal(events.filter((event) => event.type === 'close_deferred').length, 1);
  const anchors = events.filter((event) => event.type === 'checkpoint_anchor');
  assert.equal(anchors.length, 2);
  assert.equal(anchors.at(-1).payload.receipt_renderer, '0.1.27');
  const clean = verifyRun(run.id);
  assert.equal(clean.status, 'CHECKPOINT_VERIFIED');
  assert.equal(clean.ledger_advanced, false);

  const forgedMarkdown = `${readFileSync(join(directory, 'RECEIPT.md'), 'utf8')}\nforged line\n`;
  writeFileSync(join(directory, 'RECEIPT.md'), forgedMarkdown);
  const anchor = readAnchor(directory);
  anchor.receipt_markdown_hash = sha256(forgedMarkdown);
  delete anchor.receipt_renderer;
  writeFileSync(join(directory, 'checkpoint-anchor.json'), `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 10 (review F3). An interrupted seal — sealed state saved, sealed receipt files not yet written, no
// seal anchor, stale checkpoint receipts on disk — must RECOVER through repairSeal, not false-fail:
// the stale bytes are recognized by the checkpoint_anchor event that committed them.
test('an interrupted seal with stale checkpoint receipts on disk recovers', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-interrupted-seal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Interrupted seal.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const checkpointJson = readFileSync(join(directory, 'receipt.json'), 'utf8');
  const checkpointMarkdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  const checkpointAnchor = readFileSync(join(directory, 'checkpoint-anchor.json'), 'utf8');

  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_interrupted', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-interrupted');
  requestClose(parent, 'Close after evaluation.');
  assert.equal(checkpointOrSeal(parent, 'stop-2').status, 'SEALED');

  // Emulate the crash window: sealed state and run_sealed event persisted, but the sealed receipt
  // files were never written (the checkpoint bytes remain) and no seal anchor exists.
  writeFileSync(join(directory, 'receipt.json'), checkpointJson);
  writeFileSync(join(directory, 'RECEIPT.md'), checkpointMarkdown);
  writeFileSync(join(directory, 'checkpoint-anchor.json'), checkpointAnchor);
  rmSync(join(directory, 'seal-anchor.json'));

  const repaired = verifySealedRun(run.id);
  assert.equal(repaired.status, 'ALREADY_SEALED');
  assert(existsSync(join(directory, 'seal-anchor.json')));
  assert(!existsSync(join(directory, 'checkpoint-anchor.json')));
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.lifecycle.status, 'SEALED');
  // Bytes matching NEITHER the sealed render nor a ledger-committed checkpoint still fail closed.
  writeFileSync(join(directory, 'RECEIPT.md'), `${checkpointMarkdown}\ntampered\n`);
  rmSync(join(directory, 'seal-anchor.json'));
  assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11 (review F4). A torn checkpoint write — anchor event appended, crash before its receipt files
// landed — reports structurally at the prior checkpoint, never as tamper, and heals on the next Stop.
test('a torn checkpoint write verifies structurally at the prior anchor and heals on the next Stop', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-torn';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Torn checkpoint write.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const firstJson = readFileSync(join(directory, 'receipt.json'), 'utf8');
  const firstMarkdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  const firstAnchor = readFileSync(join(directory, 'checkpoint-anchor.json'), 'utf8');
  recordClaim(parent, 'A claim between checkpoints.', []);
  checkpointOrSeal(parent, 'stop-2');
  // Emulate the crash: the second anchor event is in the ledger, but the files are still the first
  // checkpoint's bytes.
  writeFileSync(join(directory, 'receipt.json'), firstJson);
  writeFileSync(join(directory, 'RECEIPT.md'), firstMarkdown);
  writeFileSync(join(directory, 'checkpoint-anchor.json'), firstAnchor);

  const anchors = getRunForTesting(run.id).events.filter((event) => event.type === 'checkpoint_anchor');
  assert.equal(anchors.length, 2);
  const torn = verifyRun(run.id);
  assert.equal(torn.status, 'CHECKPOINT_VERIFIED');
  assert.equal(torn.files_match_latest_anchor, false);
  assert.equal(torn.anchor_event_seq, anchors[0].seq);
  assert.equal(torn.latest_anchor_event_seq, anchors[1].seq);

  // The next Stop re-anchors the advanced ledger and heals the split.
  checkpointOrSeal(parent, 'stop-3');
  const healed = verifyRun(run.id);
  assert.equal(healed.status, 'CHECKPOINT_VERIFIED');
  assert.equal(healed.files_match_latest_anchor, true);
});

// 12 (review F5). A blocker set that changes and then recurs (S1 -> S2 -> S1) appends a fresh
// close_deferred each time it changes, so the lifecycle face never lists stale blockers.
test('a recurring blocker set appends a fresh observation and the face lists current blockers', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-blocker-recurrence';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Blocker recurrence.' });
  requestClose(parent, 'Please close.');
  // S1: no snapshot yet.
  assert.deepEqual(checkpointOrSeal(parent, 'stop-1').blockers, ['PR_SNAPSHOT_REQUIRED']);
  // S2: an ordinary delegated child starts and is still open.
  mintChild({ sessionId, agentId: 'delegate-1' });
  const s2 = checkpointOrSeal(parent, 'stop-2').blockers;
  assert.equal(s2.length, 2);
  assert(s2.some((code) => code.startsWith('CHILD_')));
  // Back to S1: the child stops and seals its lifecycle receipt.
  sealChildByAgent({ sessionId, agentId: 'delegate-1' });
  assert.deepEqual(checkpointOrSeal(parent, 'stop-3').blockers, ['PR_SNAPSHOT_REQUIRED']);

  const { directory, events } = getRunForTesting(run.id);
  // Three distinct observations, three close_deferred events — the recurrence did not dedupe away.
  assert.equal(events.filter((event) => event.type === 'close_deferred').length, 3);
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.deepEqual(receipt.lifecycle.blockers_observed.map((blocker) => blocker.code), ['PR_SNAPSHOT_REQUIRED']);
});

// 13 (review F6). A state cache contradicting the ledger fails open-packet verification closed even
// when the ledger has advanced past the anchor.
test('a tampered state cache fails open-packet verification closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-state-tamper';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'State tamper.' });
  checkpointOrSeal(parent, 'stop-1');
  recordClaim(parent, 'Advance the ledger.', []);
  const { directory } = getRunForTesting(run.id);
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.ledger_tip = 'f'.repeat(64);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});
