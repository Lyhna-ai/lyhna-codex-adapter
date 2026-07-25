import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  addPrSnapshot, beginEvaluation, beginRun, checkpointOrSeal, claimEvaluation,
  getRunForTesting, mintChild, mintSession, readSealedReceipt, recordClaim,
  recordEvaluation, requestClose, sealChildByAgent
} from '../src/store.mjs';
import {
  DEFAULT_KEY_ID, exportKey, importKey, keyPath, keyProtection, loadOrCreateKeypair,
  signCapsule, verifyCapsuleSignature
} from '../src/signing.mjs';
import { buildContinuation, deriveCapsuleRef } from '../src/continuation.mjs';
import { verifyLineage } from '../src/lineage.mjs';
import { canonicalJson } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

function ceremony(sessionId, parent, snapshot, agentId) {
  addPrSnapshot(parent, snapshot);
  const evaluation = beginEvaluation(parent, snapshot.id, { head: snapshot.head_after, clean: true, detached: true, path: `fx-${snapshot.id}` }, 'initial');
  const child = mintChild({ sessionId, agentId });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Finding.', [], {
    head_before: snapshot.head_after, head_after: snapshot.head_after,
    clean_before: true, clean_after: true, detached_before: true, detached_after: true
  });
  readSealedReceipt(parent, sealChildByAgent({ sessionId, agentId }).id);
}

function runWindow({ sessionId, objective, continuesFrom }) {
  const parent = mintSession({ sessionId });
  const run = beginRun(parent, { mode: 'full', objective, continuesFrom });
  ceremony(sessionId, parent, stableSnapshot, `${sessionId}-ev`);
  requestClose(parent, 'done');
  const sealed = checkpointOrSeal(parent, `${sessionId}-stop`);
  assert.equal(sealed.status, 'SEALED');
  return { run, sealed, directory: getRunForTesting(run.id).directory };
}

test('a sealed capsule is signed, and the signature verifies from the capsule alone', (t) => {
  isolatedData(t);
  const { directory } = runWindow({ sessionId: 'signed', objective: 'Sign it.' });
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));

  assert.equal(published.signature.algorithm, 'ed25519');
  assert.equal(published.signature.key_id, DEFAULT_KEY_ID);
  assert.match(published.signature.public_key, /^[0-9a-f]{64}$/);
  assert.equal(verifyCapsuleSignature(published).ok, true);
});

test('the signature does not change what the capsule is called', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({ sessionId: 'ref-stable', objective: 'Ref stability.' });
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  const { state, events } = getRunForTesting(run.id);

  // capsule_ref names the WORK; the signature attests it. Signing must not move the address,
  // which is what lets a second party counter-sign the same fold later.
  assert.equal(deriveCapsuleRef(published), buildContinuation(state, events).capsule_ref);
});

test('signing is deterministic, so a sealed packet re-renders byte-identically', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({ sessionId: 'deterministic', objective: 'Ed25519 is deterministic.' });
  const published = readFileSync(join(directory, 'continuation.json'), 'utf8');
  const { state, events } = getRunForTesting(run.id);

  const resigned = signCapsule(buildContinuation(state, events), loadOrCreateKeypair());
  assert.equal(canonicalJson(resigned, true), published);
});

test('a tampered signed capsule fails signature verification', (t) => {
  isolatedData(t);
  const { directory } = runWindow({ sessionId: 'tamper', objective: 'Do not trust bytes.' });
  const path = join(directory, 'continuation.json');
  const published = JSON.parse(readFileSync(path, 'utf8'));

  published.settled.push({ statement: 'A fact nobody witnessed.', ref: null });
  assert.equal(verifyCapsuleSignature(published).ok, false);

  // Even restamping capsule_ref to make the file self-consistent cannot forge the signature.
  published.capsule_ref = deriveCapsuleRef(published);
  assert.equal(verifyCapsuleSignature(published).ok, false);
});

test('lineage reports the signing key and fails a present-but-bad signature', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'chain-1', objective: 'First.' });
  const second = runWindow({ sessionId: 'chain-2', objective: 'Second.', continuesFrom: first.sealed.capsule_ref });

  const linked = verifyLineage(first.directory, second.directory);
  assert.equal(linked.ok, true, JSON.stringify(linked.checks, null, 2));
  assert.match(linked.prior_signed_by, /^[0-9a-f]{64}$/);
  assert.equal(linked.checks.find((c) => c.name === 'prior_signature').ok, true);

  const path = join(first.directory, 'continuation.json');
  const published = JSON.parse(readFileSync(path, 'utf8'));
  published.signature.signature = published.signature.signature.replace(/^../, 'ab');
  writeFileSync(path, canonicalJson(published, true));

  const broken = verifyLineage(first.directory, second.directory);
  assert.equal(broken.ok, false);
  assert.equal(broken.checks.find((c) => c.name === 'prior_signature').ok, false);
});

test('an unsigned capsule is reported honestly rather than treated as tampered', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'unsigned-1', objective: 'No key here.' });
  const second = runWindow({ sessionId: 'unsigned-2', objective: 'Continues.', continuesFrom: first.sealed.capsule_ref });

  const path = join(first.directory, 'continuation.json');
  const { signature: _dropped, ...unsigned } = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, canonicalJson(unsigned, true));

  const report = verifyLineage(first.directory, second.directory);
  const signature = report.checks.find((c) => c.name === 'prior_signature');
  assert.equal(signature.ok, true);
  assert.match(signature.detail, /unsigned capsule/);
  assert.equal(report.ok, true, 'an unsigned but internally consistent chain still links');
});

test('the private key is protected as far as the platform allows, and says so honestly', (t) => {
  isolatedData(t);
  loadOrCreateKeypair();
  const protection = keyProtection();

  if (protection.mode_enforced) {
    assert.equal(statSync(keyPath()).mode & 0o777, 0o600, 'POSIX must actually enforce owner-only');
    assert.match(protection.statement, /0600/);
  } else {
    // Windows cannot express a POSIX mode. Claiming owner-only there would be false, so the
    // reported protection must name the ACL it actually relies on instead.
    assert.equal(protection.platform, 'win32');
    assert.match(protection.statement, /ACL inherited from its directory/);
    assert.ok(statSync(keyPath()).isFile(), 'the key is still written');
  }
});

test('key material round-trips through export/import', (t) => {
  isolatedData(t);
  const original = loadOrCreateKeypair();

  assert.throws(() => importKey(exportKey()), /KEY_ALREADY_EXISTS/);

  const material = exportKey();
  const reimported = importKey(material, { keyId: 'carried', overwrite: false });
  assert.equal(reimported.public_key, original.public_key);

  // A capsule signed by the carried key verifies exactly as the original would.
  const capsule = { schema: 'x', capsule_ref: 'abc', settled: [] };
  assert.equal(verifyCapsuleSignature(signCapsule(capsule, loadOrCreateKeypair('carried'))).ok, true);
});

test('inconsistent key material is refused rather than silently installed', (t) => {
  isolatedData(t);
  const material = JSON.parse(exportKey(loadOrCreateKeypair().key_id));
  material.public_key = 'f'.repeat(64);
  assert.throws(() => importKey(material, { keyId: 'bogus' }), /KEY_MATERIAL_INCONSISTENT/);
});
