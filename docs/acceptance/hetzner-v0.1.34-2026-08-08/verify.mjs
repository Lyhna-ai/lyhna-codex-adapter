import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packetDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(packetDirectory, '..', '..', '..');
const runDirectory = join(packetDirectory, 'run');
const sourceCommit = '6faa65a2540b30cecf0af243df58ce889b958a18';
const expectedRunId = 'run_24cd4b2e-8328-46c6-ac37-7f1bab7c471b';
const expectedPublicKey = 'b66636f9ea8a58effc254f6a68df35762e8ce7b561b98f57debc35380bccaf6b';

const expectedFiles = new Map([
  ['capsules/026cfb7877d03ed89d324b018cd89d61c990d5c8d3eff1bdca4155c2b81eff57.json', 'f059c5f09e0d13abbae346944cfd579b82593403f35de2089bb9ed60ef251974'],
  ['capsules/14e46d2cb01629541a43cab29ffbae68636482027b55ecc0a77d41f3893515ae.json', 'e457d78107a2bc6bd869eda33d036f5ab8d80c76be3dae016f85e8a06f5c39d6'],
  ['capsules/3dbb033ab5c9582cc09276d1ce46a7d54f4f88608c62b674fddb4186eb0a3a19.json', '4f7cd8c03ebffb01366872739b507dd77b8d1223f442c3babed7fcf41f68f672'],
  ['capsules/c59ff8c98b8c0d508d6df9cd7bf3d00822ef112089f3f051fe7a00e99a6f4c60.json', '68930d3429377b63479f6399e7912b785503d10fb790e3d68c64238bf96b985b'],
  ['continuation.json', 'e457d78107a2bc6bd869eda33d036f5ab8d80c76be3dae016f85e8a06f5c39d6'],
  ['events.jsonl', '931749e9d32c9dc673ba7ab46333ad41aa779dcecc1897d89d22734771a3d0e4'],
  ['HANDOFF.md', 'ae0b633627653e6cb12c8d3561b7fa27a6178e4314679d159147275dc7192706'],
  ['receipt.json', 'c6ab48cd73939a885532eabf9365339007b711c76d6a7d2729ab41d4d71b684a'],
  ['RECEIPT.md', 'ad832517a1aa7577fa7ca1ce6177fd58ed15430bd96f9aad77d2559573f9ce3d'],
  ['seal-anchor.json', '651b49f8b5933e19c4cdace9eeffbe49f6a29f0e646962bc440250ffc1841446'],
  ['state.json', '4a77dd7a2b583fdf153592bc2c9bbf227f3b46e025f9824019d9beff7d3aa356']
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(runDirectory, relativePath), 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(args) {
  return spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });
}

const sourceExists = git(['cat-file', '-e', `${sourceCommit}^{commit}`]);
assert.equal(sourceExists.status, 0, sourceExists.stderr || `source commit ${sourceCommit} is unavailable`);
const sourceDiff = git(['diff', '--quiet', sourceCommit, '--', 'plugins/lyhna/src']);
assert.equal(
  sourceDiff.status,
  0,
  sourceDiff.status === 1
    ? `plugins/lyhna/src differs from pinned v0.1.34 source ${sourceCommit}`
    : sourceDiff.stderr
);

const [continuationModule, handoffModule, lineageModule, receiptModule, signingModule, utilModule] = await Promise.all([
  import('../../../plugins/lyhna/src/continuation.mjs'),
  import('../../../plugins/lyhna/src/handoff.mjs'),
  import('../../../plugins/lyhna/src/lineage.mjs'),
  import('../../../plugins/lyhna/src/receipt.mjs'),
  import('../../../plugins/lyhna/src/signing.mjs'),
  import('../../../plugins/lyhna/src/util.mjs')
]);
const { buildContinuation, deriveCapsuleRef } = continuationModule;
const { renderHandoffMarkdown } = handoffModule;
const { verifyLedgerChain } = lineageModule;
const { renderReceiptJson, renderReceiptMarkdown } = receiptModule;
const { verifyCapsuleSignature } = signingModule;
const { canonicalJson } = utilModule;

function listFiles(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const absolutePath = join(directory, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolutePath).isDirectory()) files.push(...listFiles(absolutePath, relativePath));
    else files.push(relativePath);
  }
  return files;
}

const actualFiles = listFiles(runDirectory);
assert.deepEqual(actualFiles, [...expectedFiles.keys()].sort(), 'run packet contains a missing or unexpected file');

for (const [relativePath, expectedHash] of expectedFiles) {
  const actualHash = sha256(readFileSync(join(runDirectory, relativePath)));
  assert.equal(actualHash, expectedHash, `${relativePath} does not match the captured packet`);
}

const chain = verifyLedgerChain(runDirectory);
assert.equal(chain.ok, true, chain.detail);
assert.equal(chain.events.length, 22);

const anchor = readJson('seal-anchor.json');
assert.equal(anchor.run_id, expectedRunId);
assert.equal(anchor.final_seq, chain.events.length);
assert.equal(anchor.final_hash, chain.tip);
assert.equal(anchor.receipt_json_hash, sha256(readFileSync(join(runDirectory, 'receipt.json'))));
assert.equal(anchor.receipt_markdown_hash, sha256(readFileSync(join(runDirectory, 'RECEIPT.md'))));
assert.equal(anchor.receipt_renderer, '0.1.34');

const state = readJson('state.json');
assert.equal(state.id, expectedRunId);
assert.equal(state.sealed, true);
assert.equal(state.privacy_mode, 'proof');
assert.equal(state.ledger_count, chain.events.length);
assert.equal(state.ledger_tip, chain.tip);
assert.equal(anchor.state_hash, sha256(canonicalJson(state)));
assert.equal(readFileSync(join(runDirectory, 'receipt.json'), 'utf8'), renderReceiptJson(state, chain.events));
assert.equal(readFileSync(join(runDirectory, 'RECEIPT.md'), 'utf8'), renderReceiptMarkdown(state, chain.events));

const continuation = readJson('continuation.json');
assert.equal(continuation.run_id, expectedRunId);
assert.equal(continuation.privacy_mode, 'proof');
assert.equal(continuation.continuation_fold_version, 'v2');
assert.equal(deriveCapsuleRef(continuation), continuation.capsule_ref);
assert.equal(continuation.signature.public_key, expectedPublicKey);
const signature = verifyCapsuleSignature(continuation);
assert.equal(signature.ok, true, signature.reason);
const { signature: _signature, ...unsignedContinuation } = continuation;
assert.deepEqual(unsignedContinuation, buildContinuation(state, chain.events, 'v2'));
assert.equal(
  readFileSync(join(runDirectory, 'HANDOFF.md'), 'utf8'),
  renderHandoffMarkdown(continuation)
);

const archivedCapsulePath = join(runDirectory, 'capsules', `${continuation.capsule_ref}.json`);
assert.deepEqual(readJson(`capsules/${continuation.capsule_ref}.json`), continuation);
assert.equal(
  sha256(readFileSync(archivedCapsulePath)),
  sha256(readFileSync(join(runDirectory, 'continuation.json')))
);

const attempts = chain.events.filter((event) => event.type === 'closeout_attempted');
assert.deepEqual(attempts.map((event) => event.payload.attempt_sequence), [1, 2, 3, 4]);
assert.deepEqual(attempts.map((event) => event.payload.ordinal), [1, 1, 2, 3]);

const seals = chain.events.filter((event) => event.type === 'run_sealed');
assert.equal(seals.length, 1);
assert.equal(seals[0], chain.events.at(-1));
assert.equal(seals[0].payload.status, 'CLOSED_UNSUPPORTED');
assert.equal(seals[0].payload.supported_state, null);

const forbiddenPrivateKeys = new Set([
  'authorization',
  'body',
  'child_capability',
  'command',
  'content',
  'cwd',
  'env',
  'environment',
  'hostname',
  'ip',
  'output',
  'password',
  'path',
  'private_key',
  'private_key_pem',
  'prompt',
  'secret',
  'session_capability',
  'statement_text',
  'token'
]);
const proofObjective = 'Objective withheld.';
const allowedProofStatements = new Set([
  'Resolve this closeout condition before treating the run as complete.',
  'Close was requested; this run had not sealed as of this fold.',
  'This run sealed at event 22; its ledger is terminal.',
  'This run is SEALED; the seal block records the closeout anchor.'
]);

function auditJson(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditJson(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenPrivateKeys.has(key), false, `${location}.${key} is forbidden in a proof packet`);
    if (key === 'objective_text') assert.equal(child, '', `${location}.objective_text must be withheld`);
    if (key === 'objective') assert.equal(child, proofObjective, `${location}.objective must use the proof marker`);
    if (key === 'statement') {
      assert.equal(
        allowedProofStatements.has(child),
        true,
        `${location}.statement is not an allowed generated proof statement`
      );
    }
    auditJson(child, `${location}.${key}`);
  }
}

const secretShapes = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bbearer\s+[A-Za-z0-9._-]+/i,
  /\blyhna_(?:session|child)_[a-f0-9]{32,}\b/i,
  /[A-Za-z]:\\/,
  /\/(?:srv|home|Users|root)\//,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\bLYHNA_[A-Z0-9_]+\s*=/
];

for (const relativePath of actualFiles) {
  const text = readFileSync(join(runDirectory, relativePath), 'utf8');
  for (const pattern of secretShapes) {
    assert.equal(pattern.test(text), false, `${relativePath} contains a forbidden private-data shape`);
  }
  if (relativePath.endsWith('.json')) auditJson(JSON.parse(text), relativePath);
  if (relativePath.endsWith('.jsonl')) {
    text.split('\n').filter(Boolean).forEach((line, index) => auditJson(JSON.parse(line), `${relativePath}:${index + 1}`));
  }
}
assert.equal(state.objective_text_withheld, true);
assert.equal(state.objective, proofObjective);
assert.equal(readJson('receipt.json').objective, proofObjective);
assert.equal(continuation.objective, proofObjective);

const report = {
  schema: 'lyhna.portable-acceptance-verification.v1',
  packet: 'hetzner-v0.1.34-2026-08-08',
  run_id: expectedRunId,
  checks: {
    source_implementation_pin: 'PASS',
    exact_file_set: 'PASS',
    captured_file_hashes: 'PASS',
    ledger_chain: 'PASS',
    sealed_anchor: 'PASS',
    canonical_state_hash: 'PASS',
    receipt_hashes: 'PASS',
    receipt_refold: 'PASS',
    capsule_content_address: 'PASS',
    continuation_refold: 'PASS',
    handoff_refold: 'PASS',
    capsule_signature: 'PASS',
    pinned_public_identity: 'PASS',
    proof_privacy_audit: 'PASS',
    proof_narrative_allowlist: 'PASS',
    closeout_attempts: [1, 2, 3, 4],
    closeout_ordinals: [1, 1, 2, 3],
    terminal_seal_count: 1,
    terminal_status: 'CLOSED_UNSUPPORTED'
  },
  ledger: {
    event_count: chain.events.length,
    tip: chain.tip
  },
  capsule: {
    ref: continuation.capsule_ref,
    public_key: signature.public_key,
    signature_reason: signature.reason
  },
  limitation: 'This verifies the copied run packet, its local hash chain, sealed anchor, and embedded-key signature. It does not independently prove Hetzner host configuration, adversary-resistant custody, deployment correctness, or real-world outcomes.'
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
