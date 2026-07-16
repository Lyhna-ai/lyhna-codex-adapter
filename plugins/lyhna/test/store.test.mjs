import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  addPrSnapshot,
  activeRunFor,
  beginEvaluation,
  beginRun,
  checkpointOrSeal,
  claimEvaluation,
  getCapability,
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
  sealChildByAgent,
  verifySealedRun
} from '../src/store.mjs';
import { sanitizeHook } from '../src/redact.mjs';
import { sha256 } from '../src/util.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

function pendingRecord(root, sessionId) {
  return JSON.parse(readFileSync(join(root, 'pending', `${sha256(sessionId)}.json`), 'utf8'));
}

function missMarkerPath(root, prompt) {
  return join(root, 'pending-miss', `miss-${sha256(prompt).slice(0, 16)}.json`);
}

function runBegunEvent(runId) {
  return getRunForTesting(runId).events.find((event) => event.type === 'run_begun');
}

test('capabilities are hook-bound, isolated, and parent cannot self-review', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'session-a', cwd: process.cwd() });
  assert.equal(mintSession({ sessionId: 'session-a', cwd: process.cwd() }), parent);
  assert.notEqual(mintSession({ sessionId: 'session-b', cwd: process.cwd() }), parent);
  const run = beginRun(parent, { mode: 'full', objective: 'Build the requested feature.' });
  addPrSnapshot(parent, stableSnapshot);
  assert.throws(() => beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: false, path: 'attached-fixture' }), /EVALUATOR_CHECKOUT_REQUIRED/);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
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

test('open legacy runs drop persisted child receipt paths on the next save', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const parent = mintSession({ sessionId: 'legacy-path-migration', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Migrate an open run.' });
  mintChild({ sessionId: 'legacy-path-migration', agentId: 'ordinary-child' });
  const receipt = sealChildByAgent({ sessionId: 'legacy-path-migration', agentId: 'ordinary-child' });
  const stateFile = join(getRunForTesting(run.id).directory, 'state.json');
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'));
  legacy.child_receipts[receipt.id].path = receipt.path;
  writeFileSync(stateFile, `${JSON.stringify(legacy, null, 2)}\n`);

  recordClaim(parent, 'Continue the migrated open run.', []);

  const migratedText = readFileSync(stateFile, 'utf8');
  const migrated = JSON.parse(migratedText);
  assert.equal(migrated.child_receipts[receipt.id].path, undefined);
  assert(!migratedText.includes(data));
  assert.equal(readSealedReceipt(parent, receipt.id).id, receipt.id);
});

test('close-ready legacy runs drop persisted child receipt paths before sealing', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const parent = mintSession({ sessionId: 'legacy-path-seal', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Seal a migrated run.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'legacy-path-seal', agentId: 'evaluator-child' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'No material mismatch.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const receipt = sealChildByAgent({ sessionId: 'legacy-path-seal', agentId: 'evaluator-child' });
  readSealedReceipt(parent, receipt.id);
  requestClose(parent, 'Seal after migration.');
  const stateFile = join(getRunForTesting(run.id).directory, 'state.json');
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'));
  legacy.child_receipts[receipt.id].path = receipt.path;
  writeFileSync(stateFile, `${JSON.stringify(legacy, null, 2)}\n`);

  assert.equal(checkpointOrSeal(parent).status, 'SEALED');

  const sealedText = readFileSync(stateFile, 'utf8');
  const sealed = JSON.parse(sealedText);
  assert.equal(sealed.child_receipts[receipt.id].path, undefined);
  assert(!sealedText.includes(data));
  assert.equal(verifySealedRun(run.id).status, 'ALREADY_SEALED');
});

test('full run distinguishes hook evidence and seals only after evaluator receipt retrieval', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'parent-session', cwd: process.cwd() });
  const state = beginRun(parent, { mode: 'full', objective: 'Implement exact-head evaluation.' });

  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'call-1' }), 'pre-1');
  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'call-1', status: 'failed' }), 'post-1');
  recordHookForParent(parent, sanitizeHook({ hook_event_name: 'PermissionRequest', tool_name: 'exec_command', event_id: 'perm-1' }), 'perm-1');
  recordClaim(parent, 'The feature is complete.', []);
  const ordinaryChild = mintChild({ sessionId: 'parent-session', agentId: 'ordinary-worker' });
  assert.notEqual(ordinaryChild, parent);
  assert.equal(checkpointOrSeal(parent).status, 'CHECKPOINTED');

  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'parent-session', agentId: 'evaluator-agent' });
  claimEvaluation(child, evaluation.id);
  const seededCheckout = {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  };
  recordEvaluation(child, evaluation.id, 'Seeded requirement mismatch remains.', ['test:seeded-mismatch'], seededCheckout);
  const retriedFinding = recordEvaluation(child, evaluation.id, 'Seeded requirement mismatch remains.', ['test:seeded-mismatch'], seededCheckout);
  assert.equal(retriedFinding.findings.length, 1);
  assert.equal(getRunForTesting(state.id).events.filter((event) => event.type === 'evaluation_finding').length, 1);
  const multiFinding = recordEvaluation(child, evaluation.id, 'Documentation evidence was also examined.', ['test:docs'], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  assert.equal(multiFinding.findings.length, 2);
  requestClose(parent, 'Evaluation recorded.');
  const openChildren = checkpointOrSeal(parent);
  assert.equal(openChildren.status, 'CLOSE_DEFERRED');
  assert(openChildren.blockers.some((blocker) => /^CHILD_child_agent_.*_OPEN$/.test(blocker)));
  const ordinaryReceipt = sealChildByAgent({ sessionId: 'parent-session', agentId: 'ordinary-worker' });
  assert.equal(ordinaryReceipt.role, 'delegated_agent');
  assert.equal(ordinaryReceipt.status, 'STOP_OBSERVED');
  assert.equal(sealChildByAgent({ sessionId: 'parent-session', agentId: 'ordinary-worker' }).id, ordinaryReceipt.id);
  const ordinaryContent = readSealedReceipt(parent, ordinaryReceipt.id);
  assert.equal(ordinaryContent.lifecycle.start.support, 'lifecycle_observed_not_execution');
  assert.equal(ordinaryContent.lifecycle.stop.support, 'lifecycle_observed_not_execution');
  assert.match(ordinaryContent.lifecycle.start.event_ref, /^[a-f0-9]{64}$/);
  assert.match(ordinaryContent.lifecycle.stop.event_ref, /^[a-f0-9]{64}$/);
  assert.match(ordinaryContent.limitations[0], /lifecycle coverage only/);
  const childReceipt = sealChildByAgent({ sessionId: 'parent-session', agentId: 'evaluator-agent' });
  assert.equal(childReceipt.status, 'RECORDED');
  assert.throws(() => recordEvaluation(child, evaluation.id, 'Late finding.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  }), /EVALUATION_RECEIPT_SEALED/);
  const childOriginal = readFileSync(childReceipt.path, 'utf8');
  const evaluatorContent = JSON.parse(childOriginal);
  assert.match(evaluatorContent.lifecycle.start.event_ref, /^[a-f0-9]{64}$/);
  assert.match(evaluatorContent.lifecycle.stop.event_ref, /^[a-f0-9]{64}$/);
  writeFileSync(childReceipt.path, childOriginal.replace('RECORDED', 'ALTERED'));
  assert.throws(() => readSealedReceipt(parent, childReceipt.id), /LOCAL_CHAIN_BROKEN/);
  writeFileSync(childReceipt.path, childOriginal);
  assert.equal(listChildReceipts(parent).length, 2);
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
  assert.deepEqual(parsed.child_receipts.map((item) => item.role).sort(), ['delegated_agent', 'evaluator']);
  assert.equal(activeRunFor(parent), null);
  assert.throws(() => recordClaim(parent, 'late mutation', []), /NO_ACTIVE_RUN/);
  const nextRun = beginRun(parent, { mode: 'full', objective: 'A new explicit run.' });
  assert.notEqual(nextRun.id, state.id);
  addPrSnapshot(parent, stableSnapshot);
  const nextEvaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const reboundChild = mintChild({ sessionId: 'parent-session', agentId: 'evaluator-agent' });
  assert.notEqual(reboundChild, child);
  assert.equal(claimEvaluation(reboundChild, nextEvaluation.id).status, 'CLAIMED');
  assert.equal(readSealedReceipt(parent, childReceipt.id).id, childReceipt.id);
  assert.equal(readLedger(state.id, { allowOpen: false }).length, parsed.evidence.length);
});

test('sealed state and rendered receipt tampering are detected', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'artifact-tamper', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Bind rendered artifacts.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'artifact-tamper', agentId: 'artifact-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Examined.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true, detached_before: true, detached_after: true });
  const childReceipt = sealChildByAgent({ sessionId: 'artifact-tamper', agentId: 'artifact-evaluator' });
  readSealedReceipt(parent, childReceipt.id);
  requestClose(parent, 'Close.');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');
  const directory = getRunForTesting(run.id).directory;
  const childPath = childReceipt.path;
  const childOriginal = readFileSync(childPath, 'utf8');
  writeFileSync(childPath, `${childOriginal}\nlocal alteration\n`);
  assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
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
    assert.throws(() => verifySealedRun(run.id), /LOCAL_CHAIN_BROKEN/);
    assert.throws(() => readSealedReceipt(parent, childReceipt.id), /LOCAL_CHAIN_BROKEN/);
    writeFileSync(path, original);
  }
});

test('stale lock ownership is recovered and free-form credentials never persist', { concurrency: false }, (t) => {
  const root = isolatedData(t);
  const rawPrompt = '@lyhna build the private customer feature password=hunter2 Authorization: Basic dXNlcjpwYXNz without copying this full prompt';
  const sensitiveCwd = 'C:\\Users\\Adam\\Customers\\private-customer';
  rememberInvocation({ sessionId: 'privacy-lock', prompt: rawPrompt });
  const parent = mintSession({ sessionId: 'privacy-lock', cwd: sensitiveCwd });
  const capability = getCapability(parent);
  assert.equal(capability.cwd, undefined);
  assert.equal(capability.cwd_ref.sha256.length, 64);
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
  assert(!all.includes(sensitiveCwd));
  assert(all.includes('Invocation objective retained by hash'));
  assert(!all.includes('private customer feature'));
});

test('invocation capture recognizes a boundary Lyhna mention anywhere in the prompt', { concurrency: false }, (t) => {
  isolatedData(t);
  for (const [index, prompt] of [
    'Email adam@lyhna.example about the report.',
    '@lyhnatic is a different token.',
    '@lyhna-reviewer is a different token.',
    '$lyhna-other is a different token.',
    'see plugin://lyhna-codex-adapter-test docs',
    '[fork docs](plugin://lyhna-codex-adapter-test) for the fork',
    '@lyhna_adapter is a different token.',
    '$lyhna_other is a different token.',
    '@lyhna-codex-adapter_beta is a different token.',
    'see plugin://lyhna-codex-adapter_beta docs'
  ].entries()) {
    assert.equal(rememberInvocation({ sessionId: `negative-${index}`, prompt }), false);
    const parent = mintSession({ sessionId: `negative-${index}`, cwd: process.cwd() });
    assert.equal(beginRun(parent, { mode: 'full', objective: 'Fallback objective.' }).objective_origin, 'agent_reported');
  }
  for (const [index, prompt] of [
    'Do not invoke @lyhna for this task.',
    'Quoted example: "@lyhna review this PR".',
    '[@Lyhna](plugin://lyhna-codex-adapter@another-marketplace) is a different marketplace.',
    '`@lyhna` is the documented syntax.',
    '[@Lyhna](plugin://lyhna-reviewer@lyhna-ai) shows the @Lyhna display text.',
    '@lyhna-codex-adapter@lyhna-ai please move this forward.',
    'wrap check [@lyhna] please',
    '**@lyhna** run this',
    'resume—@lyhna continue the loop',
    '[Lyhna Codex Adapter](plugin://lyhna-codex-adapter@lyhna-ai) go ahead.',
    'invoke plugin://lyhna-codex-adapter@lyhna-ai now'
  ].entries()) {
    assert.equal(rememberInvocation({ sessionId: `boundary-positive-${index}`, prompt }), true);
    const parent = mintSession({ sessionId: `boundary-positive-${index}`, cwd: process.cwd() });
    assert.equal(beginRun(parent, { mode: 'full', objective: 'Fallback objective.' }).objective_origin, 'runtime_hook');
  }
  assert.equal(rememberInvocation({ sessionId: 'positive-at', prompt: '  @Lyhna review PR #1.' }), true);
  const atParent = mintSession({ sessionId: 'positive-at', cwd: process.cwd() });
  assert.equal(beginRun(atParent, { mode: 'full', objective: 'Fallback objective.' }).objective_origin, 'runtime_hook');
  assert.equal(rememberInvocation({ sessionId: 'positive-dollar', prompt: '$lyhna: examine this PR.' }), true);
  assert.equal(rememberInvocation({
    sessionId: 'positive-plugin',
    prompt: ' [@Lyhna](plugin://lyhna-codex-adapter@lyhna-ai) examine this PR.'
  }), true);
});

test('invocation capture records the matched form and structural offset', { concurrency: false }, (t) => {
  const root = isolatedData(t);

  const preambleLong = 'Great job , thank you.\n\n@lyhna-codex-adapter Please move forward with this above plan.';
  assert.equal(rememberInvocation({ sessionId: 'preamble-long', prompt: preambleLong }), true);
  const longRecord = pendingRecord(root, 'preamble-long');
  assert.equal(longRecord.matched_form, 'literal_long');
  assert.equal(longRecord.mention_offset, preambleLong.indexOf('@lyhna-codex-adapter'));
  assert.equal(longRecord.prompt_bytes, Buffer.byteLength(preambleLong));
  assert.match(longRecord.summary, /Invocation objective retained by hash/);

  const midSentence = 'please use @lyhna for this';
  assert.equal(rememberInvocation({ sessionId: 'mid-short', prompt: midSentence }), true);
  const shortRecord = pendingRecord(root, 'mid-short');
  assert.equal(shortRecord.matched_form, 'literal_short');
  assert.equal(shortRecord.mention_offset, midSentence.indexOf('@lyhna'));

  const dollar = '$lyhna please examine this PR.';
  assert.equal(rememberInvocation({ sessionId: 'lead-dollar', prompt: dollar }), true);
  const dollarRecord = pendingRecord(root, 'lead-dollar');
  assert.equal(dollarRecord.matched_form, 'literal_dollar');
  assert.equal(dollarRecord.mention_offset, 0);

  const structured = 'Thanks for the plan. [@Lyhna](plugin://lyhna-codex-adapter@lyhna-ai) please examine it.';
  assert.equal(rememberInvocation({ sessionId: 'preamble-structured', prompt: structured }), true);
  const structuredRecord = pendingRecord(root, 'preamble-structured');
  assert.equal(structuredRecord.matched_form, 'structured');
  assert.equal(structuredRecord.mention_offset, structured.indexOf('[@Lyhna'));

  const qualified = '@lyhna-codex-adapter@lyhna-ai please continue.';
  assert.equal(rememberInvocation({ sessionId: 'qualified-long', prompt: qualified }), true);
  assert.equal(pendingRecord(root, 'qualified-long').matched_form, 'literal_long');

  const bareUri = 'invoke plugin://lyhna-codex-adapter@lyhna-ai now';
  assert.equal(rememberInvocation({ sessionId: 'bare-uri', prompt: bareUri }), true);
  const bareUriRecord = pendingRecord(root, 'bare-uri');
  assert.equal(bareUriRecord.matched_form, 'structured');
  assert.equal(bareUriRecord.mention_offset, bareUri.indexOf('plugin://'));

  const parts = [
    { type: 'text', text: 'Great job on the plan.' },
    { type: 'mention', text: '@lyhna-codex-adapter' },
    { type: 'text', text: 'please move forward.' }
  ];
  assert.equal(rememberInvocation({ sessionId: 'structured-parts', prompt: parts }), true);
  assert.equal(pendingRecord(root, 'structured-parts').matched_form, 'literal_long');

  const objectPayload = { content: [{ plugin: 'plugin://lyhna-codex-adapter@lyhna-ai' }] };
  assert.equal(rememberInvocation({ sessionId: 'object-payload', prompt: objectPayload }), true);
  assert.equal(pendingRecord(root, 'object-payload').matched_form, 'structured');

  const displayTextMention = [{ text: 'Lyhna', uri: 'plugin://lyhna-codex-adapter@lyhna-ai' }, { text: 'please continue.' }];
  assert.equal(rememberInvocation({ sessionId: 'display-text-mention', prompt: displayTextMention }), true);
  assert.equal(pendingRecord(root, 'display-text-mention').matched_form, 'structured');

  assert.equal(rememberInvocation({ sessionId: 'preamble-long-e2e', prompt: preambleLong }), true);
  const e2eParent = mintSession({ sessionId: 'preamble-long-e2e', cwd: process.cwd() });
  const e2eRun = beginRun(e2eParent, { mode: 'full', objective: 'Continue the reviewed loop.' });
  assert.equal(e2eRun.objective_origin, 'runtime_hook');
  assert.equal(runBegunEvent(e2eRun.id).payload.invocation.matched_form, 'literal_long');
});

test('miss markers stop accumulating at the deterministic limit', { concurrency: false }, (t) => {
  const root = isolatedData(t);
  for (let index = 0; index < 40; index += 1) {
    assert.equal(rememberInvocation({ sessionId: `flood-${index}`, prompt: `lyhna filler number ${index}` }), false);
  }
  const markers = readdirSync(join(root, 'pending-miss'));
  assert.equal(markers.length, 32);
});

test('unrecognized prompts leave a content-free miss marker', { concurrency: false }, (t) => {
  const root = isolatedData(t);

  const email = 'email adam@lyhna.ai about it';
  assert.equal(rememberInvocation({ sessionId: 'miss-email', prompt: email }), false);
  assert(!existsSync(join(root, 'pending', `${sha256('miss-email')}.json`)));
  const emailMarker = JSON.parse(readFileSync(missMarkerPath(root, email), 'utf8'));
  assert.equal(emailMarker.ref, sha256(email));
  assert.equal(emailMarker.prompt_bytes, Buffer.byteLength(email));
  assert.equal(emailMarker.contains_at_sigil, true);
  assert.equal(emailMarker.contains_plugin_uri, false);
  assert(!JSON.stringify(emailMarker).includes(email));

  const bareMention = 'the lyhna adapter is neat';
  assert.equal(rememberInvocation({ sessionId: 'miss-bare', prompt: bareMention }), false);
  const bareMarker = JSON.parse(readFileSync(missMarkerPath(root, bareMention), 'utf8'));
  assert.equal(bareMarker.contains_at_sigil, false);
  assert.equal(bareMarker.contains_dollar_sigil, false);
  assert.equal(bareMarker.contains_plugin_uri, false);
  assert.deepEqual(bareMarker.mention_contexts, ['aaa aaaaa aaaaaaa aa aaaa']);

  const unknownShape = '[@lyhna-widget](plugin://other-widget) run it';
  assert.equal(rememberInvocation({ sessionId: 'miss-shape', prompt: unknownShape }), false);
  const shapeMarker = JSON.parse(readFileSync(missMarkerPath(root, unknownShape), 'utf8'));
  assert.match(shapeMarker.mention_contexts[0], /\[@aaaaa-aaaaaa\]\(aaaaaa:/);
  assert(!JSON.stringify(shapeMarker).includes('widget'));

  const unicodePrompt = '秘密のlyhnaトークン désolé';
  assert.equal(rememberInvocation({ sessionId: 'miss-unicode', prompt: unicodePrompt }), false);
  const unicodeMarker = JSON.parse(readFileSync(missMarkerPath(root, unicodePrompt), 'utf8'));
  assert.match(unicodeMarker.mention_contexts[0], /^[\x20-\x7e]*$/);
  assert(!JSON.stringify(unicodeMarker.mention_contexts).includes('秘'));
  assert(!JSON.stringify(unicodeMarker.mention_contexts).includes('désolé'));

  assert.equal(rememberInvocation({ sessionId: 'miss-foo', prompt: '@lyhnafoo hello' }), false);
  assert(existsSync(missMarkerPath(root, '@lyhnafoo hello')));
  assert(!existsSync(join(root, 'debug')));
});

test('remembered invocation threads structural evidence into run_begun', { concurrency: false }, (t) => {
  isolatedData(t);
  assert.equal(rememberInvocation({ sessionId: 'thread-parent', prompt: 'please run @lyhna on this.' }), true);
  const parent = mintSession({ sessionId: 'thread-parent', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Fallback objective.' });
  assert.equal(run.objective_origin, 'runtime_hook');
  const begun = runBegunEvent(run.id);
  assert.equal(begun.payload.invocation.matched_form, 'literal_short');
  assert.equal(begun.payload.invocation.mention_offset, 'please run '.length);

  const plain = mintSession({ sessionId: 'thread-plain', cwd: process.cwd() });
  const plainRun = beginRun(plain, { mode: 'full', objective: 'No prior invocation.' });
  assert.equal(plainRun.objective_origin, 'agent_reported');
  const plainBegun = runBegunEvent(plainRun.id);
  assert.equal('invocation' in plainBegun.payload, false);
});

test('pending invocation evidence is consumed by begin_run', { concurrency: false }, (t) => {
  const root = isolatedData(t);
  const sessionId = 'consume-invocation';
  assert.equal(rememberInvocation({ sessionId, prompt: '@lyhna begin this run.' }), true);
  assert.equal(readdirSync(join(root, 'pending')).length, 1);
  const parent = mintSession({ sessionId, cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Fallback.' });
  assert.equal(run.objective_origin, 'runtime_hook');
  assert.equal(readdirSync(join(root, 'pending')).length, 0);
  assert.equal(rememberInvocation({ sessionId, prompt: '@lyhna continue this run.' }), true);
  assert.equal(beginRun(parent, { mode: 'full', objective: 'Ignored.' }).id, run.id);
  assert.equal(readdirSync(join(root, 'pending')).length, 0);
});

test('dirty evaluator tree is an explicit integrity exception', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'dirty-parent', cwd: process.cwd() });
  beginRun(parent, { mode: 'full', objective: 'Check dirty state.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'dirty-parent', agentId: 'dirty-evaluator' });
  claimEvaluation(child, evaluation.id);
  const result = recordEvaluation(child, evaluation.id, 'Finding from modified tree.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: false,
    detached_before: true,
    detached_after: true
  });
  assert.equal(result.status, 'CHECKOUT_INTEGRITY_EXCEPTION');
  const laterCleanFinding = recordEvaluation(child, evaluation.id, 'A later check was clean.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  assert.equal(laterCleanFinding.findings.length, 2);
  assert.equal(laterCleanFinding.status, 'CHECKOUT_INTEGRITY_EXCEPTION');
});

test('inconsistent snapshots are blocked and explicit refresh marks prior work stale', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'stale-parent', cwd: process.cwd() });
  beginRun(parent, { mode: 'full', objective: 'Check head drift.' });
  addPrSnapshot(parent, { ...stableSnapshot, id: 'bad', head_after: 'c'.repeat(40), status: 'INCONSISTENT_SNAPSHOT' });
  assert.throws(() => beginEvaluation(parent, 'bad'), /INCONSISTENT_SNAPSHOT/);
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'stale-parent', agentId: 'stale-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Exact-head finding.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const refresh = markSnapshotRefreshed(parent, stableSnapshot.id, 'd'.repeat(40));
  assert.equal(refresh.stale, true);
  assert.throws(() => recordEvaluation(child, evaluation.id, 'Stale late finding.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  }), /EVALUATION_NOT_RECORDABLE/);
  const run = beginRun(parent, { mode: 'full' });
  let current = getRunForTesting(run.id).state;
  assert.equal(current.evaluations[evaluation.id].status, 'STALE');
  assert.equal(current.pr_snapshots[stableSnapshot.id].status, 'STALE');

  const unclaimedSnapshot = { ...stableSnapshot, id: 'pr_stale_unclaimed' };
  addPrSnapshot(parent, unclaimedSnapshot);
  const unclaimed = beginEvaluation(parent, unclaimedSnapshot.id, { head: unclaimedSnapshot.head_after, clean: true, detached: true, path: 'fixture-unclaimed' });
  markSnapshotRefreshed(parent, unclaimedSnapshot.id, 'e'.repeat(40));
  const unclaimedChild = mintChild({ sessionId: 'stale-parent', agentId: 'unclaimed-evaluator' });
  assert.throws(() => claimEvaluation(unclaimedChild, unclaimed.id), /EVALUATION_NOT_CLAIMABLE/);
  assert.equal(sealChildByAgent({ sessionId: 'stale-parent', agentId: 'unclaimed-evaluator' }).role, 'delegated_agent');

  const freshSnapshot = {
    ...stableSnapshot,
    id: 'pr_fresh',
    head_before: 'd'.repeat(40),
    head_after: 'd'.repeat(40)
  };
  addPrSnapshot(parent, freshSnapshot);
  const freshEvaluation = beginEvaluation(parent, freshSnapshot.id, { head: freshSnapshot.head_after, clean: true, detached: true, path: 'fixture-fresh' });
  const freshChild = mintChild({ sessionId: 'stale-parent', agentId: 'fresh-evaluator' });
  assert.notEqual(freshChild, child);
  claimEvaluation(freshChild, freshEvaluation.id);
  recordEvaluation(freshChild, freshEvaluation.id, 'Fresh exact-head finding.', [], {
    head_before: freshSnapshot.head_after,
    head_after: freshSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const freshReceipt = sealChildByAgent({ sessionId: 'stale-parent', agentId: 'fresh-evaluator' });
  assert.equal(freshReceipt.id, `child_${freshEvaluation.id}`);
  readSealedReceipt(parent, freshReceipt.id);
  requestClose(parent, 'Fresh evaluation supersedes stale history.');
  const latestSnapshot = {
    ...stableSnapshot,
    id: 'pr_latest',
    head_before: 'e'.repeat(40),
    head_after: 'e'.repeat(40)
  };
  addPrSnapshot(parent, latestSnapshot);
  const deferred = checkpointOrSeal(parent);
  assert.equal(deferred.status, 'CLOSE_DEFERRED');
  assert(deferred.blockers.includes('EVALUATION_pr_latest_REQUIRED'));
  const latestEvaluation = beginEvaluation(parent, latestSnapshot.id, { head: latestSnapshot.head_after, clean: true, detached: true, path: 'fixture-latest' });
  const latestChild = mintChild({ sessionId: 'stale-parent', agentId: 'latest-evaluator' });
  claimEvaluation(latestChild, latestEvaluation.id);
  recordEvaluation(latestChild, latestEvaluation.id, 'Latest exact-head finding.', [], {
    head_before: latestSnapshot.head_after,
    head_after: latestSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const latestReceipt = sealChildByAgent({ sessionId: 'stale-parent', agentId: 'latest-evaluator' });
  readSealedReceipt(parent, latestReceipt.id);
  const staleChildBlocker = checkpointOrSeal(parent);
  assert.equal(staleChildBlocker.status, 'CLOSE_DEFERRED');
  assert(staleChildBlocker.blockers.some((blocker) => /^CHILD_child_agent_.*_OPEN$/.test(blocker)));
  const staleLifecycleReceipt = sealChildByAgent({ sessionId: 'stale-parent', agentId: 'stale-evaluator' });
  assert.equal(staleLifecycleReceipt.role, 'evaluator');
  assert.equal(staleLifecycleReceipt.status, 'STOP_OBSERVED');
  const staleLifecycleContent = readFileSync(staleLifecycleReceipt.path, 'utf8');
  assert.equal(JSON.parse(staleLifecycleContent).evaluation_status, 'STALE');
  assert.equal(checkpointOrSeal(parent).status, 'SEALED');
  current = getRunForTesting(run.id).state;
  assert.equal(current.evaluations[evaluation.id].status, 'STALE');
  assert.equal(current.evaluations[freshEvaluation.id].status, 'RECORDED');
});

test('ledger mutation, deletion, reordering, and sealed-tail truncation are detected', { concurrency: false }, (t) => {
  isolatedData(t);
  const parent = mintSession({ sessionId: 'tamper-parent', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Tamper test.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'tamper-parent', agentId: 'tamper-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'No material mismatch.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true, detached_before: true, detached_after: true });
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
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const child = mintChild({ sessionId: 'recovery-parent', agentId: 'recovery-evaluator' });
  claimEvaluation(child, evaluation.id);
  recordEvaluation(child, evaluation.id, 'Recovery path examined.', [], { head_before: stableSnapshot.head_after, head_after: stableSnapshot.head_after, clean_before: true, clean_after: true, detached_before: true, detached_after: true });
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
