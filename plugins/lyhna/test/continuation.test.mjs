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
  readSealedReceipt,
  recordClaim,
  recordEvaluation,
  requestClose,
  sealChildByAgent
} from '../src/store.mjs';
import { buildContinuation, deriveCapsuleRef, labelClaims } from '../src/continuation.mjs';
import { renderHandoffMarkdown } from '../src/handoff.mjs';
import { renderLineageMarkdown, verifyLineage, verifyLedgerChain } from '../src/lineage.mjs';
import { canonicalJson } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

/** The closeout ceremony a full run requires before it may seal. */
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

/** Drive one window from begin to seal, returning its packet directory and sealed capsule. */
function runWindow({ sessionId, objective, continuesFrom, privacyMode, claims = [] }) {
  const parent = mintSession({ sessionId });
  const run = beginRun(parent, { mode: 'full', objective, continuesFrom, privacyMode });
  for (const claim of claims) recordClaim(parent, claim.statement, claim.evidence_refs || []);
  evaluateAndRetrieve(sessionId, parent, stableSnapshot, `${sessionId}-evaluator`);
  requestClose(parent, 'Window complete.');
  const sealed = checkpointOrSeal(parent, `${sessionId}-stop`);
  assert.equal(sealed.status, 'SEALED');
  return { parent, run, sealed, directory: getRunForTesting(run.id).directory };
}

test('the continuation capsule is a deterministic fold of the ledger', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({ sessionId: 'w1', objective: 'Build the thing.' });
  const { state, events } = getRunForTesting(run.id);

  const first = buildContinuation(state, events);
  const second = buildContinuation(state, events);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.capsule_ref, deriveCapsuleRef(first));
  // The published file is the same fold, not a separately authored document.
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(published.capsule_ref, first.capsule_ref);
});

test('claims are labeled against witnessed evidence, not accepted as narration', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'claims' });
  const run = beginRun(parent, { mode: 'full', objective: 'Check claims.' });
  const anchor = recordClaim(parent, 'First observable step completed.', []);

  recordClaim(parent, 'Backed by a real event in this run.', [`sha256:${anchor.event_hash}`]);
  recordClaim(parent, 'Backed by something this run never saw.', [`sha256:${'e'.repeat(64)}`]);

  const { events } = getRunForTesting(run.id);
  const labeled = labelClaims(events);
  const bySupport = Object.fromEntries(labeled.map((claim) => [claim.support, claim.statement]));

  assert.equal(labeled.length, 3);
  assert.ok(bySupport.UNSUPPORTED, 'a claim citing no evidence is UNSUPPORTED');
  assert.ok(bySupport.SUPPORTED, 'a claim citing a witnessed event is SUPPORTED');
  assert.ok(bySupport.UNRESOLVED_EVIDENCE, 'a claim citing an unknown ref is UNRESOLVED_EVIDENCE, not UNSUPPORTED');
});

test('sealing writes a handoff that carries the unsupported claims forward', (t) => {
  isolatedData(t);
  const { run, sealed, directory } = runWindow({
    sessionId: 'handoff',
    objective: 'Ship the lane.',
    claims: [{ statement: 'I definitely deployed this to production.' }]
  });

  assert.ok(existsSync(join(directory, 'HANDOFF.md')));
  assert.ok(existsSync(join(directory, 'continuation.json')));
  assert.equal(sealed.capsule_ref, JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')).capsule_ref);

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /the previous agent did not write it/);
  assert.match(handoff, /UNSUPPORTED/);
  assert.match(handoff, /have no witnessed support in that run/);
  assert.match(handoff, new RegExp(sealed.capsule_ref));

  // The capsule the handoff renders from must be the run's own fold, plus its signature.
  const published = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  const { state, events } = getRunForTesting(run.id);
  assert.equal(deriveCapsuleRef(published), buildContinuation(state, events).capsule_ref);
  assert.equal(renderHandoffMarkdown(published), handoff);
});

test('every Stop refreshes the handoff, so an abandoned window still hands off', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'abandoned' });
  const run = beginRun(parent, { mode: 'full', objective: 'Run out of context.' });
  recordClaim(parent, 'Partial work happened.', []);

  // No close request — this window is simply left behind, which is the common real case.
  const checkpoint = checkpointOrSeal(parent);
  assert.notEqual(checkpoint.status, 'SEALED');

  const directory = getRunForTesting(run.id).directory;
  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.status, 'OPEN');
  assert.ok(capsule.open.some((item) => /No close request was observed/.test(item.statement)));
  assert.ok(existsSync(join(directory, 'HANDOFF.md')));
});

test('a second window that continues the first verifies as linked', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'window-1', objective: 'First window.' });
  const second = runWindow({
    sessionId: 'window-2',
    objective: 'Second window.',
    continuesFrom: first.sealed.capsule_ref
  });

  // The edge resolved locally and recorded the PRIOR packet's state hash, not a caller-supplied one.
  assert.equal(second.run.inherits.resolution, 'RESOLVED_LOCAL_PACKET');
  assert.equal(second.run.inherits.run_id, first.run.id);

  // And it lives inside the hash chain.
  const runBegun = getRunForTesting(second.run.id).events.find((event) => event.type === 'run_begun');
  assert.equal(runBegun.payload.inherits.capsule_ref, first.sealed.capsule_ref);

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.ok(report.checks.every((item) => item.ok));
  assert.match(report.trust_notice, /does NOT prove the observations were true/);
  assert.match(report.trust_notice, /not custody against the machine that produced the packet/);
});

test('lineage fails when the second window commits to a different capsule', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'real-1', objective: 'The real prior window.' });
  const decoy = runWindow({ sessionId: 'decoy', objective: 'A different window entirely.' });
  const second = runWindow({
    sessionId: 'real-2',
    objective: 'Continues the decoy, not the first.',
    continuesFrom: decoy.sealed.capsule_ref
  });

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  const mismatch = report.checks.find((item) => item.name === 'inheritance_capsule_ref_matches');
  assert.equal(mismatch.ok, false);
});

test('lineage fails when a published continuation is edited after the fact', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'edited-1', objective: 'Original objective.' });
  const second = runWindow({
    sessionId: 'edited-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });
  assert.equal(verifyLineage(first.directory, second.directory).ok, true);

  // Rewrite the prior handoff's settled list AND restamp its identity so the file is internally
  // self-consistent. Only re-folding from the ledger catches this.
  const path = join(first.directory, 'continuation.json');
  const tampered = JSON.parse(readFileSync(path, 'utf8'));
  tampered.settled.push({ statement: 'A fact nobody witnessed.', ref: null });
  tampered.capsule_ref = deriveCapsuleRef(tampered);
  writeFileSync(path, canonicalJson(tampered, true));

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_capsule_ref_self_consistent').ok, true);
  assert.equal(report.checks.find((item) => item.name === 'prior_continuation_refolds').ok, false);
});

test('a check that could not run is reported NOT RUN, never dropped from the report', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'notrun-1', objective: 'Original window.' });
  const second = runWindow({
    sessionId: 'notrun-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });

  const clean = verifyLineage(first.directory, second.directory);
  assert.equal(clean.ok, true, JSON.stringify(clean.checks, null, 2));

  // Break the prior ledger itself: edit an event's content so it no longer hashes to its recorded
  // event_hash. The re-fold now has no trustworthy input — but a reader must be told that, not left
  // to notice a missing row.
  const ledgerPath = join(first.directory, 'events.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim());
  const opening = JSON.parse(lines[0]);
  opening.payload = { ...opening.payload, mode: 'pr_only' };
  lines[0] = JSON.stringify(opening);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_chain_valid').status, 'FAIL');

  const refolds = report.checks.find((item) => item.name === 'prior_continuation_refolds');
  assert.equal(refolds.status, 'NOT_RUN');
  assert.equal(refolds.ok, false, 'an unknown must never count as a pass');
  assert.match(refolds.detail, /does not chain-validate/);

  // Same rows, same order, whatever the outcome — a row must never vanish between two reports.
  assert.deepEqual(
    report.checks.map((item) => item.name),
    clean.checks.map((item) => item.name)
  );
  assert.match(renderLineageMarkdown(report), /NOT RUN — `prior_continuation_refolds`/);
});

test('a packet with nothing to check still reports every check it did not run', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'empty-1', objective: 'Window with a deleted capsule.' });
  const second = runWindow({
    sessionId: 'empty-2',
    objective: 'Continues it.',
    continuesFrom: first.sealed.capsule_ref
  });
  const complete = verifyLineage(first.directory, second.directory).checks.map((item) => item.name);

  rmSync(join(first.directory, 'continuation.json'));

  const report = verifyLineage(first.directory, second.directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'prior_continuation_present').status, 'FAIL');
  assert.deepEqual(report.checks.map((item) => item.name), complete);
  for (const item of report.checks.slice(1)) {
    assert.equal(item.status, 'NOT_RUN', `${item.name} should be NOT RUN, not omitted`);
  }
});

test('a predecessor this store cannot see is recorded as unresolved, not invented', (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'stranger' });
  const run = beginRun(parent, { mode: 'full', objective: 'Continue a packet from another machine.', continuesFrom: 'f'.repeat(64) });

  assert.equal(run.inherits.resolution, 'UNRESOLVED_LOCALLY');
  assert.equal(run.inherits.capsule_ref, 'f'.repeat(64));
  assert.equal(run.inherits.state_hash, null);
});

test('the lineage checker re-walks the chain itself rather than trusting the store reader', (t) => {
  isolatedData(t);
  const { directory } = runWindow({ sessionId: 'chain', objective: 'Chain check.' });
  assert.equal(verifyLedgerChain(directory).ok, true);

  const ledgerPath = join(directory, 'events.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.payload = { ...first.payload, objective_origin: 'runtime_hook' };
  lines[0] = canonicalJson(first);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const broken = verifyLedgerChain(directory);
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /hash does not match its content/);
});

test('the owner sees their own claim: verified context retains the words', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'plain',
    objective: 'Read my own claims.',
    claims: [{ statement: 'I deployed the migration to production and it succeeded.' }]
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.privacy_mode, 'verified_context');
  assert.equal(capsule.claims[0].statement_text, 'I deployed the migration to production and it succeeded.');

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /I deployed the migration to production and it succeeded\./);
  assert.ok(capsule.open.some((item) => /I deployed the migration to production/.test(item.statement)));
});

test('proof mode projects the words away but keeps the verdict auditable', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'blind',
    objective: 'Share this packet.',
    privacyMode: 'proof',
    claims: [{ statement: 'I deployed the migration to production and it succeeded.' }]
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.privacy_mode, 'proof');
  assert.equal(capsule.claims[0].statement_text, undefined);
  assert.equal(capsule.claims[0].support, 'UNSUPPORTED');
  assert.ok(capsule.claims[0].statement_ref, 'the claim stays addressable by hash');

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.doesNotMatch(handoff, /I deployed the migration/);
  assert.match(handoff, /claim text is projected away in this packet/);
  assert.match(handoff, /UNSUPPORTED/);
  assert.doesNotMatch(readFileSync(join(directory, 'receipt.json'), 'utf8'), /I deployed the migration/);
});

test('secrets are still scrubbed from retained claim text', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'secrets',
    objective: 'Do not leak.',
    claims: [{ statement: 'Deployed with token=ghp_abcdefghijklmnopqrstuvwxyz012345 as configured.' }]
  });

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Deployed with/);
  assert.doesNotMatch(handoff, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(handoff, /REDACTED/);
});

test('privacy mode is sealed into the chain, so rendering never depends on the environment', (t) => {
  isolatedData(t);
  const { run, directory } = runWindow({
    sessionId: 'sealed-mode',
    objective: 'Determinism.',
    privacyMode: 'proof',
    claims: [{ statement: 'A claim whose words are withheld.' }]
  });

  const runBegun = getRunForTesting(run.id).events.find((event) => event.type === 'run_begun');
  assert.equal(runBegun.payload.privacy_mode, 'proof');

  const { signature: _published, ...before } = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  process.env.LYHNA_PRIVACY_MODE = 'verified_context';
  t.after(() => { delete process.env.LYHNA_PRIVACY_MODE; });
  const { state, events } = getRunForTesting(run.id);
  assert.equal(canonicalJson(buildContinuation(state, events)), canonicalJson(before));
});

test('the request survives the handoff instead of arriving as a byte count', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'objective',
    objective: 'Port the judgment ledger and close the drift on the canonical context.'
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, 'Port the judgment ledger and close the drift on the canonical context.');
  assert.match(capsule.objective, /retained by hash/, 'the structural summary is kept alongside');

  // The next window reads the request, not its length.
  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Port the judgment ledger and close the drift/);
});

test('proof mode withholds the request from a packet that leaves the machine', (t) => {
  isolatedData(t);
  const { directory } = runWindow({
    sessionId: 'objective-blind',
    objective: 'Port the judgment ledger and close the drift on the canonical context.',
    privacyMode: 'proof'
  });

  const capsule = JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, undefined);
  assert.match(capsule.objective, /retained by hash/);

  const handoff = readFileSync(join(directory, 'HANDOFF.md'), 'utf8');
  assert.doesNotMatch(handoff, /Port the judgment ledger/);
  assert.match(handoff, /text withheld in this packet/);
});

test('the retained request carries forward into the inherited state hash', (t) => {
  isolatedData(t);
  const first = runWindow({ sessionId: 'obj-1', objective: 'The original request.' });
  const second = runWindow({ sessionId: 'obj-2', objective: 'Continues it.', continuesFrom: first.sealed.capsule_ref });

  // objective_text is part of the carry-forward core, so a successor commits to the request itself
  // and not merely to its shape.
  assert.equal(verifyLineage(first.directory, second.directory).ok, true);
  const capsule = JSON.parse(readFileSync(join(first.directory, 'continuation.json'), 'utf8'));
  assert.equal(capsule.objective_text, 'The original request.');
});
