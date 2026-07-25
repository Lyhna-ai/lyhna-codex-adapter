import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  addPrSnapshot,
  appendEvent,
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

// Append a validly hash-chained event straight to events.jsonl, bypassing the store's append guard.
// Simulates an externally-tampered/corrupt ledger (e.g. a write appended after run_sealed) for the
// detection paths — the store API itself now refuses to create such corruption.
function rawAppendEvent(directory, { type, origin, payload, idempotencyKey }) {
  const ledger = join(directory, 'events.jsonl');
  const raw = readFileSync(ledger, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const contentHash = sha256(canonicalJson({ origin, payload, type }));
  const event = {
    schema: 'lyhna.codex.event.v0',
    seq: lines.length + 1,
    prev_hash: JSON.parse(lines.at(-1)).event_hash,
    idempotency_key: idempotencyKey || contentHash,
    content_hash: contentHash,
    type,
    origin,
    payload
  };
  event.event_hash = sha256(canonicalJson(event));
  writeFileSync(ledger, `${raw.endsWith('\n') ? raw : `${raw}\n`}${canonicalJson(event)}\n`);
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
  assert.equal(anchorEvent.payload.receipt_renderer, '0.1.30');
  assert.equal(anchorEvent.payload.receipt_json_hash, sha256(readFileSync(join(directory, 'receipt.json'), 'utf8')));
  assert.equal(anchorEvent.payload.receipt_markdown_hash, sha256(readFileSync(join(directory, 'RECEIPT.md'), 'utf8')));
  const anchor = readAnchor(directory);
  assert.equal(anchor.run_id, run.id);
  assert.equal(anchor.as_of_seq, events.length - 1);
  assert.equal(anchor.anchor_event_seq, anchorEvent.seq);
  assert.equal(anchor.tip_hash, events.at(-2).event_hash);
  assert.equal(anchor.receipt_renderer, '0.1.30');
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
  assert.equal(events.at(-2).payload.receipt_renderer, '0.1.30');
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
  assert.equal(events.at(-2).payload.receipt_renderer, '0.1.30');
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
  assert.equal(anchors.at(-1).payload.receipt_renderer, '0.1.30');
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

// 11b (Codex round-2). A torn write on the FIRST checkpoint (anchor event committed, crash before the
// receipt files were written) has no earlier packet to fall back to. Absent files are a benign
// incomplete write, not tamper: verifyRun reports CHECKPOINT_INCOMPLETE and confirms the content is
// reconstructable from the ledger — it never throws LOCAL_CHAIN_BROKEN.
test('a first-checkpoint torn write reports structurally incomplete, not tampered', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-first-torn';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'First checkpoint torn write.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  // Emulate the crash window: the checkpoint_anchor event is in the ledger, but neither receipt file
  // (nor the convenience anchor file) was written.
  rmSync(join(directory, 'receipt.json'));
  rmSync(join(directory, 'RECEIPT.md'));
  rmSync(join(directory, 'checkpoint-anchor.json'), { force: true });
  const result = verifyRun(run.id);
  assert.equal(result.status, 'CHECKPOINT_INCOMPLETE');
  assert.equal(result.content_reproducible_from_ledger, true);

  // Present-but-wrong files with no matching anchor are still tamper, even at the first checkpoint.
  writeFileSync(join(directory, 'receipt.json'), '{"FORGED":true}\n');
  writeFileSync(join(directory, 'RECEIPT.md'), 'forged\n');
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 10b (Codex round-4). Compound crash: the FINAL pre-seal checkpoint write was torn (receipt files
// still hold an EARLIER checkpoint's bytes), and then the seal is also interrupted. repairSeal must
// recover — the on-disk bytes match an earlier committed checkpoint anchor, not just the last — using
// the same newest-first tolerance verifyOpenPacket applies, never classifying them as tamper.
test('an interrupted seal recovers when the final checkpoint write was also torn', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-compound-crash';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Compound checkpoint+seal crash.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const firstJson = readFileSync(join(directory, 'receipt.json'), 'utf8');
  const firstMarkdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  recordClaim(parent, 'Work between checkpoints.', []);
  checkpointOrSeal(parent, 'stop-2');

  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_compound', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-compound');
  requestClose(parent, 'Close after evaluation.');
  assert.equal(checkpointOrSeal(parent, 'stop-3').status, 'SEALED');

  // Emulate both crashes at once: the sealed receipt files were never written AND the bytes on disk
  // are the FIRST checkpoint's (the second checkpoint write had been torn), plus no seal anchor.
  writeFileSync(join(directory, 'receipt.json'), firstJson);
  writeFileSync(join(directory, 'RECEIPT.md'), firstMarkdown);
  rmSync(join(directory, 'seal-anchor.json'));
  assert.equal(verifySealedRun(run.id).status, 'ALREADY_SEALED');
  assert(existsSync(join(directory, 'seal-anchor.json')));

  // Bytes matching no committed checkpoint at all still fail closed.
  writeFileSync(join(directory, 'RECEIPT.md'), `${firstMarkdown}\ntampered\n`);
  rmSync(join(directory, 'seal-anchor.json'));
  assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11c (Codex round-2). A MIXED torn write — crash between the two atomic receipt-file renames, so one
// file is the new checkpoint's bytes and the other is the prior checkpoint's — matches no single
// anchor fully, but each present file is still vouched for by some committed anchor. Benign: reported
// structurally, not tamper. A present file matching no committed anchor stays tamper.
test('a mixed torn write (one file new, one old) reports structurally, not tampered', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-mixed-torn';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Mixed torn write.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const firstMarkdown = readFileSync(join(directory, 'RECEIPT.md'), 'utf8');
  recordClaim(parent, 'A claim between checkpoints.', []);
  checkpointOrSeal(parent, 'stop-2');
  // Crash between the two renames: receipt.json is the second checkpoint's, RECEIPT.md is the first's.
  writeFileSync(join(directory, 'RECEIPT.md'), firstMarkdown);
  const result = verifyRun(run.id);
  assert.equal(result.status, 'CHECKPOINT_INCOMPLETE');

  // Replace the markdown with content no committed anchor vouches for → tamper.
  writeFileSync(join(directory, 'RECEIPT.md'), `${firstMarkdown}\nforged\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11d (Codex round-3). A Stop crash after both receipt files are renamed but before
// checkpoint-anchor.json is rewritten leaves the receipt files matching the LATEST anchor while the
// convenience file still names the PRIOR one. The file is a cache, not a trust root: a stale-but-valid
// lag verifies as the latest checkpoint, never tamper.
test('a stale checkpoint-anchor file after fresh receipt writes still verifies at the latest anchor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-stale-anchor-file';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Stale anchor-file crash window.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  const firstAnchorFile = readFileSync(join(directory, 'checkpoint-anchor.json'), 'utf8');
  recordClaim(parent, 'A claim between checkpoints.', []);
  checkpointOrSeal(parent, 'stop-2');
  // Both receipt files are the second checkpoint's; the anchor file lagged and still names the first.
  writeFileSync(join(directory, 'checkpoint-anchor.json'), firstAnchorFile);
  const result = verifyRun(run.id);
  assert.equal(result.status, 'CHECKPOINT_VERIFIED');
  assert.equal(result.files_match_latest_anchor, true);

  // An anchor file naming no committed anchor at all is an incoherent cache and fails closed.
  const forged = JSON.parse(firstAnchorFile);
  forged.anchor_event_seq = 999;
  writeFileSync(join(directory, 'checkpoint-anchor.json'), `${JSON.stringify(forged, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11f (Codex round-7). A redelivered Stop with the same delivery key, after other activity, must not
// anchor: the turn_checkpoint dedupes, so re-anchoring would mutate the chain for a repeated hook with
// no new observation. Idempotent replay leaves the ledger and the single anchor unchanged.
test('a replayed Stop after later activity appends no new checkpoint anchor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-replay';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Replayed Stop delivery.' });
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CHECKPOINTED');
  recordClaim(parent, 'Work after the checkpoint.', []);
  const before = getRunForTesting(run.id);
  const anchorsBefore = before.events.filter((event) => event.type === 'checkpoint_anchor').length;
  // The Stop hook redelivers with the same delivery key.
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CHECKPOINTED');
  const after = getRunForTesting(run.id);
  // No new turn_checkpoint and no new checkpoint_anchor: the replay was fully idempotent.
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.events.filter((event) => event.type === 'checkpoint_anchor').length, anchorsBefore);
  assert.equal(after.events.filter((event) => event.type === 'turn_checkpoint').length, 1);
});

// 11g (Codex round-7, close-deferred branch). The same replay on a deferred close: an unchanged
// blocker set after later activity appends neither close_deferred nor a new anchor.
test('a replayed deferred-close Stop after later activity appends no new anchor', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-replay-deferred';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Replayed deferred-close Stop.' });
  requestClose(parent, 'Please close.');
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CLOSE_DEFERRED');
  recordClaim(parent, 'Work after the deferred close.', []);
  const before = getRunForTesting(run.id);
  const anchorsBefore = before.events.filter((event) => event.type === 'checkpoint_anchor').length;
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CLOSE_DEFERRED');
  const after = getRunForTesting(run.id);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.events.filter((event) => event.type === 'checkpoint_anchor').length, anchorsBefore);
  assert.equal(after.events.filter((event) => event.type === 'close_deferred').length, 1);
});

// 11h (Codex round-8, P1). Open-packet verification must hash-check the sealed child receipt files
// named by the state, exactly as the sealed path does — a corrupted or deleted child artifact must
// not hide behind an otherwise-valid parent checkpoint.
test('open-packet verification fails closed on a tampered child receipt file', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-child-verify';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Child receipt tamper on an open packet.' });
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_child', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-child');
  checkpointOrSeal(parent, 'stop-1');
  const opened = getRunForTesting(run.id);
  assert.equal(verifyRun(run.id).status, 'CHECKPOINT_VERIFIED');
  const childId = Object.keys(opened.state.child_receipts)[0];
  const childPath = join(opened.directory, 'child-receipts', childId, 'receipt.json');
  writeFileSync(childPath, `${readFileSync(childPath, 'utf8')}\ntampered\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11i (Codex round-8, P1). A replayed Stop must not mutate or seal the run even if its blockers have
// cleared since the original delivery — repeated-hook idempotency governs the seal path too.
test('a replayed Stop after blockers clear does not seal the run', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-replay-seal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'A replayed Stop must not seal.' });
  const snapshotId = 'pr_seal2';
  addPrSnapshot(parent, { ...stableSnapshot, id: snapshotId, head_before: HEAD_A, head_after: HEAD_A });
  requestClose(parent, 'Please close.');
  // Blocker present (evaluation required): the first Stop defers.
  assert.equal(checkpointOrSeal(parent, 'stop-1').status, 'CLOSE_DEFERRED');
  // Clear the blocker via a full evaluation + child seal + retrieval.
  const evaluation = beginEvaluation(parent, snapshotId, { head: HEAD_A, clean: true, detached: true, path: `fixture-${snapshotId}` }, 'initial');
  const child = mintChild({ sessionId, agentId: 'evaluator-seal2' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Finding.', [], {
    head_before: HEAD_A, head_after: HEAD_A, clean_before: true, clean_after: true, detached_before: true, detached_after: true
  });
  const receipt = sealChildByAgent({ sessionId, agentId: 'evaluator-seal2' });
  readSealedReceipt(parent, receipt.id);
  // Replay the SAME Stop delivery: not newly observed, so it must NOT seal.
  const replay = checkpointOrSeal(parent, 'stop-1');
  assert.equal(replay.replayed_delivery, true);
  assert.equal(getRunForTesting(run.id).state.sealed, false);
  // A genuinely new Stop delivery seals.
  assert.equal(checkpointOrSeal(parent, 'stop-2').status, 'SEALED');
});

// 11e (Codex round-5). A corrupted checkpoint-anchor.json cache must surface as LOCAL_CHAIN_BROKEN
// even in the torn-write (incomplete) branch — an incomplete write must not hide a mutated cache.
test('a corrupted anchor cache fails closed even in the incomplete-write branch', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-incomplete-badcache';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Incomplete write with corrupted cache.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  // Torn write: both receipt files absent (would otherwise report CHECKPOINT_INCOMPLETE)...
  rmSync(join(directory, 'receipt.json'));
  rmSync(join(directory, 'RECEIPT.md'));
  // ...but the anchor cache is mutated to name a non-existent anchor event.
  const anchor = readAnchor(directory);
  anchor.anchor_event_seq = 999;
  writeFileSync(join(directory, 'checkpoint-anchor.json'), `${JSON.stringify(anchor, null, 2)}\n`);
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
});

// 11k (Codex round-10, P2). If a Stop crashes after its turn_checkpoint is appended and state saved
// but before the closeout runs, that checkpoint is still the ledger tip. A redelivery must be
// detected as a replay by its existing delivery key — not inferred from tip position — and must NOT
// seal, even in a close-ready run. The seal happens only on a genuinely new Stop.
test('a redelivered Stop whose checkpoint is still the ledger tip does not seal', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-tip-replay';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Replay when the checkpoint is the tip.' });
  // Make the run close-ready (all blockers satisfied), then request close.
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_tip', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-tip');
  requestClose(parent, 'Please close.');
  // Emulate the crash window: append only the turn_checkpoint + save state, no closeout. This is
  // exactly what checkpointOrSeal does before the seal branch, reproduced via the store directly.
  appendEvent(run.id, {
    type: 'turn_checkpoint',
    origin: 'runtime_hook',
    payload: { status: 'OPEN', receipt_renderer: '0.1.30' },
    idempotencyKey: 'checkpoint:stop-1'
  });
  const tip = getRunForTesting(run.id);
  assert.equal(tip.events.at(-1).type, 'turn_checkpoint');
  assert.equal(tip.state.sealed, false);
  // Redelivery of the same Stop: its checkpoint key already exists → replay, no seal.
  const replay = checkpointOrSeal(parent, 'stop-1');
  assert.equal(replay.replayed_delivery, true);
  assert.equal(getRunForTesting(run.id).state.sealed, false);
  // A genuinely new Stop seals.
  assert.equal(checkpointOrSeal(parent, 'stop-2').status, 'SEALED');
});

// 11l (Codex round-11, P2). If a Stop crashes after run_sealed is appended to the ledger but before
// state.sealed and the seal anchor are written, the ledger is sealed while state.sealed is false. A
// redelivery must FINALIZE the seal (not be swallowed by the replay guard), since the Stop hook is
// the only close trigger and no later Stop is guaranteed.
test('a redelivered Stop finalizes a seal whose run_sealed event is already in the ledger', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-seal-crash';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Seal interrupted after run_sealed.' });
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_sealcrash', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-sealcrash');
  requestClose(parent, 'Please close.');
  // Emulate the crash window: the Stop appended its turn_checkpoint and the run_sealed event, but
  // died before state.sealed / the seal anchor were written (appendEvent saves ledger position only).
  appendEvent(run.id, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  const crashed = getRunForTesting(run.id);
  assert.equal(crashed.state.sealed, false);
  assert(!existsSync(join(crashed.directory, 'seal-anchor.json')));

  // Redelivery of the same Stop: adopts the ledger's run_sealed and finalizes via repairSeal.
  const result = checkpointOrSeal(parent, 'stop-1');
  assert.equal(result.status, 'ALREADY_SEALED');
  const finalized = getRunForTesting(run.id);
  assert.equal(finalized.state.sealed, true);
  assert(existsSync(join(finalized.directory, 'seal-anchor.json')));
  const receipt = JSON.parse(readFileSync(join(finalized.directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'SEALED');
});

// 11m (Codex round-12, P1). If events were appended AFTER run_sealed (a hook wrote to the run while
// state falsely looked active in the seal crash window), that is post-seal corruption — the seal
// finalization must fail closed, never fold those observations into the sealed receipt.
test('a ledger with events after run_sealed fails closed instead of folding them into the seal', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-postseal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Post-seal corruption.' });
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_postseal', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-postseal');
  requestClose(parent, 'Please close.');
  appendEvent(run.id, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  // A stray observation lands AFTER run_sealed. The store API now refuses to create this, so simulate
  // an externally-tampered ledger by writing the line directly.
  rawAppendEvent(getRunForTesting(run.id).directory, { type: 'builder_claim', origin: 'agent_reported', payload: { statement: 'post-seal write' }, idempotencyKey: 'claim:post-seal' });
  // The redelivery must refuse to finalize a seal that has events after it.
  assert.throws(() => checkpointOrSeal(parent, 'stop-1'), /LOCAL_CHAIN_BROKEN/);
  assert.equal(getRunForTesting(run.id).state.sealed, false);
});

// 11n (Codex round-13, P1). If a Stop crashes after its turn_checkpoint is appended but before
// writeCheckpointArtifacts wrote the anchor + receipts, the redelivery must FINISH the interrupted
// packet (not just return), so the observed Stop has its verifiable checkpoint.
test('a redelivered Stop completes an interrupted checkpoint packet', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-finish-packet';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Interrupted checkpoint packet.' });
  // Emulate the crash: turn_checkpoint appended and state saved, but no checkpoint_anchor / receipts.
  appendEvent(run.id, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  const before = getRunForTesting(run.id);
  assert.equal(before.events.at(-1).type, 'turn_checkpoint');
  assert.equal(verifyRun(run.id).status, 'OPEN_NO_CHECKPOINT');
  // Redelivery finishes the packet.
  const replay = checkpointOrSeal(parent, 'stop-1');
  assert.equal(replay.replayed_delivery, true);
  const after = getRunForTesting(run.id);
  assert.equal(after.events.at(-1).type, 'checkpoint_anchor');
  assert.equal(verifyRun(run.id).status, 'CHECKPOINT_VERIFIED');
  // A second redelivery is now a no-op: the packet is complete, so no fresh anchor is appended.
  checkpointOrSeal(parent, 'stop-1');
  assert.equal(getRunForTesting(run.id).events.filter((event) => event.type === 'checkpoint_anchor').length, 1);
});

// 11o (Codex round-13, P2). Two run_sealed events with a post-seal write between must fail closed —
// checking only the last event would miss the earlier seal and fold the middle write into the receipt.
test('a ledger with a second run_sealed after a post-seal write fails closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-double-seal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Double run_sealed corruption.' });
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_double', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-double');
  requestClose(parent, 'Please close.');
  appendEvent(run.id, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  // The store API refuses post-seal appends; write the tampered continuation directly.
  const { directory } = getRunForTesting(run.id);
  rawAppendEvent(directory, { type: 'builder_claim', origin: 'agent_reported', payload: { statement: 'post-seal write' }, idempotencyKey: 'claim:post-seal' });
  rawAppendEvent(directory, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: 'seal:duplicate' });
  // Terminal event is run_sealed, but the FIRST run_sealed is not terminal → corruption, fail closed.
  assert.throws(() => checkpointOrSeal(parent, 'stop-1'), /LOCAL_CHAIN_BROKEN/);
  assert.equal(getRunForTesting(run.id).state.sealed, false);
});

// 11p (Codex round-13, P2). verifyRun must not misclassify a durable-sealed ledger as open: a reader
// calling it before any hook redelivery, when run_sealed is in the ledger but state.sealed never
// persisted, must adopt the ledger seal and report the sealed packet.
test('verifyRun adopts a terminal ledger seal instead of reporting the run open', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-verify-seal';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'verifyRun adopts a ledger seal.' });
  evaluateAndRetrieve(sessionId, parent, { ...stableSnapshot, id: 'pr_vseal', head_before: HEAD_A, head_after: HEAD_A }, 'evaluator-vseal');
  requestClose(parent, 'Please close.');
  appendEvent(run.id, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  assert.equal(getRunForTesting(run.id).state.sealed, false);
  // A reader verifies BEFORE any hook redelivery.
  const result = verifyRun(run.id);
  assert.equal(result.status, 'ALREADY_SEALED');
  const finalized = getRunForTesting(run.id);
  assert.equal(finalized.state.sealed, true);
  assert(existsSync(join(finalized.directory, 'seal-anchor.json')));
  const receipt = JSON.parse(readFileSync(join(finalized.directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'SEALED');
});

// 11q (Codex round-15, P1). Every mutable tool must fail closed on a durable-sealed ledger whose
// state.sealed flag lags it — no tool may append after a terminal run_sealed and corrupt the packet.
test('a mutable tool appends nothing after a terminal run_sealed and reports RUN_SEALED', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-postseal-tool';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Post-seal tool append.' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  const before = getRunForTesting(run.id);
  assert.equal(before.state.sealed, false);
  const eventCount = before.events.length;
  // record_claim reaches the shared append path; it must fail closed, not append after run_sealed.
  assert.throws(() => recordClaim(parent, 'A claim after the ledger sealed.', []), /RUN_SEALED/);
  assert.equal(getRunForTesting(run.id).events.length, eventCount);
});

// 11r (Codex round-16, P1). begin_run is a likely recovery path: if the prior run's ledger is
// durable-sealed but state.sealed lagged, begin_run must finalize it and start fresh, not reattach to
// a run every mutable tool would reject with RUN_SEALED.
test('begin_run finalizes a durable-sealed prior run instead of reattaching to it', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz16-reattach';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'First run.' });
  appendEvent(run.id, { type: 'run_sealed', origin: 'runtime_hook', payload: { status: 'SEALED', receipt_renderer: '0.1.30' }, idempotencyKey: `seal:${run.id}` });
  assert.equal(getRunForTesting(run.id).state.sealed, false);
  // A recovery begin_run must not hand back the sealed-ledger run.
  const next = beginRun(parent, { mode: 'full', objective: 'Second run.' });
  assert.notEqual(next.id, run.id);
  assert.equal(next.sealed, false);
  // The prior run is finalized: sealed with an anchor.
  const prior = getRunForTesting(run.id);
  assert.equal(prior.state.sealed, true);
  assert(existsSync(join(prior.directory, 'seal-anchor.json')));
});

// 11s (Codex round-17, P1). If the original delivery crashed after appending turn_checkpoint to the
// ledger but before saveState, the cached state lags. The replay must recover the state prefix before
// anchoring, or the committed state hash would be for a shorter prefix and verifyRun would reject it.
test('a replayed Stop recovers a lagging state prefix before completing the packet', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz17-lagging-state';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Lagging state on replay.' });
  const { directory } = getRunForTesting(run.id);
  const statePath = join(directory, 'state.json');
  // Crash after appending turn_checkpoint to events.jsonl but before saveState: ledger has it, state
  // lags. Read state.json directly here — getRunForTesting/readLedger would reconcile and hide the lag.
  rawAppendEvent(directory, { type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.30' }, idempotencyKey: 'checkpoint:stop-1' });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).ledger_count, 1);
  // The redelivery completes the packet from the recovered prefix; without the recovery verifyRun
  // would reject the anchor's stale state hash as LOCAL_CHAIN_BROKEN.
  const replay = checkpointOrSeal(parent, 'stop-1');
  assert.equal(replay.replayed_delivery, true);
  assert.equal(verifyRun(run.id).status, 'CHECKPOINT_VERIFIED');
});

// 11j (Codex round-9, P2). A present-but-malformed checkpoint-anchor.json is local corruption and
// must fail closed as a structural LOCAL_CHAIN_BROKEN, never leak a raw Node SyntaxError.
test('a malformed checkpoint-anchor cache fails open-packet verification closed', { concurrency: false }, (t) => {
  isolatedData(t);
  const sessionId = 'cz14-malformed-cache';
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Malformed anchor cache.' });
  checkpointOrSeal(parent, 'stop-1');
  const { directory } = getRunForTesting(run.id);
  writeFileSync(join(directory, 'checkpoint-anchor.json'), '{ not valid json');
  assert.throws(() => verifyRun(run.id), /LOCAL_CHAIN_BROKEN/);
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
