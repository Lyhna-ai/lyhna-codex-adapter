import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  addPrSnapshot,
  beginEvaluation,
  beginRun,
  claimEvaluation,
  getRunForTesting,
  mintChild,
  mintSession,
  readSealedReceipt,
  recordEvaluation,
  requestClose,
  sealChildByAgent
} from '../src/store.mjs';
import { ADAPTER_VERSION } from '../src/version.mjs';
import { isolatedData, stableSnapshot } from './helpers.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function runNode(script, input, env) {
  const result = spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function runNodeEval(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
  });
}

test('real hook processes mint distinct capabilities and repeated delivery is idempotent', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const env = { ...process.env, LYHNA_CODEX_DATA: data };
  const hook = join(pluginRoot, 'hooks', 'capture.mjs');
  const session = runNode(hook, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'live-session', cwd: process.cwd(), model: 'codex' }), env)[0];
  const context = session.hookSpecificOutput.additionalContext;
  const parent = context.match(/LYHNA_SESSION_CAPABILITY=([^\s.]+)/)[1];
  const run = beginRun(parent, { mode: 'full', objective: 'Process fixture' });
  const childOutput = runNode(hook, JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'live-session', agent_id: 'child-1' }), env)[0];
  const child = childOutput.hookSpecificOutput.additionalContext.match(/LYHNA_CHILD_CAPABILITY=([^\s.]+)/)[1];
  assert.notEqual(child, parent);
  const childStop = JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'live-session', agent_id: 'child-1', event_id: 'child-stop-1' });
  runNode(hook, childStop, env);
  runNode(hook, childStop, env);
  const childReceipts = Object.values(getRunForTesting(run.id).state.child_receipts);
  assert.equal(childReceipts.length, 1);
  assert.equal(childReceipts[0].role, 'delegated_agent');
  assert.equal(childReceipts[0].path, undefined);
  const current = getRunForTesting(run.id);
  const childPath = join(current.directory, 'child-receipts', childReceipts[0].id, 'receipt.json');
  const childLifecycle = JSON.parse(readFileSync(childPath, 'utf8')).lifecycle;
  assert(!readFileSync(join(current.directory, 'state.json'), 'utf8').includes(data));
  assert.equal(childLifecycle.start.support, 'lifecycle_observed_not_execution');
  assert.equal(childLifecycle.stop.support, 'lifecycle_observed_not_execution');
  assert.match(childLifecycle.start.event_ref, /^[a-f0-9]{64}$/);
  assert.match(childLifecycle.stop.event_ref, /^[a-f0-9]{64}$/);
  runNode(hook, JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'live-session', agent_id: 'never-started', event_id: 'orphan-stop' }), env);
  assert.equal(Object.values(getRunForTesting(run.id).state.child_receipts).length, 1);
  const pre = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'live-session', tool_name: 'exec_command', tool_use_id: 'same-delivery' });
  runNode(hook, pre, env);
  runNode(hook, pre, env);
  runNode(hook, JSON.stringify({ hook_event_name: 'Stop', session_id: 'live-session', event_id: 'stop-1' }), env);
  runNode(hook, JSON.stringify({ hook_event_name: 'Stop', session_id: 'live-session', event_id: 'stop-1' }), env);
  const events = getRunForTesting(run.id).events;
  assert.equal(events.filter((event) => event.payload?.event_id === 'same-delivery').length, 1);
  assert.equal(events.filter((event) => event.type === 'turn_checkpoint').length, 1);
});

test('concurrent child start and parent close never seal an accepted child outside state', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const parent = mintSession({ sessionId: 'race-session', cwd: process.cwd() });
  const run = beginRun(parent, { mode: 'full', objective: 'Race child registration against close.' });
  addPrSnapshot(parent, stableSnapshot);
  const evaluation = beginEvaluation(parent, stableSnapshot.id, { head: stableSnapshot.head_after, clean: true, detached: true, path: 'fixture' });
  const evaluator = mintChild({ sessionId: 'race-session', agentId: 'race-evaluator' });
  claimEvaluation(evaluator, evaluation.id);
  recordEvaluation(evaluator, evaluation.id, 'Race precondition examined.', [], {
    head_before: stableSnapshot.head_after,
    head_after: stableSnapshot.head_after,
    clean_before: true,
    clean_after: true,
    detached_before: true,
    detached_after: true
  });
  const evaluatorReceipt = sealChildByAgent({ sessionId: 'race-session', agentId: 'race-evaluator' });
  readSealedReceipt(parent, evaluatorReceipt.id);
  requestClose(parent, 'Race close requested.');

  const env = {
    ...process.env,
    LYHNA_CODEX_DATA: data,
    STORE_URL: pathToFileURL(join(pluginRoot, 'src', 'store.mjs')).href,
    PARENT_CAPABILITY: parent
  };
  const startSource = `
    const store = await import(process.env.STORE_URL);
    try { store.mintChild({ sessionId: 'race-session', agentId: 'race-ordinary' }); } catch {}
  `;
  const closeSource = `
    const store = await import(process.env.STORE_URL);
    store.checkpointOrSeal(process.env.PARENT_CAPABILITY);
  `;
  await Promise.all([runNodeEval(startSource, env), runNodeEval(closeSource, env)]);

  const observed = getRunForTesting(run.id);
  const ordinaryChildren = Object.values(observed.state.children).filter((child) => child.role === 'delegated_agent');
  const registeredIds = new Set(Object.values(observed.state.children).map((child) => child.id));
  for (const event of observed.events.filter((item) => item.type === 'child_started')) {
    assert(registeredIds.has(event.payload.child_id));
  }
  if (observed.state.sealed) {
    assert.equal(ordinaryChildren.length, 0);
  } else {
    assert.equal(ordinaryChildren.length, 1);
    assert.equal(ordinaryChildren[0].status, 'STARTED');
    assert(observed.events.some((event) => event.type === 'child_started' && event.payload.child_id === ordinaryChildren[0].id));
  }
});

test('MCP stdio process initializes, lists tools, accepts a valid call, and rejects malformed input', { concurrency: false }, (t) => {
  const data = isolatedData(t);
  const env = { ...process.env, LYHNA_CODEX_DATA: data };
  const hook = join(pluginRoot, 'hooks', 'capture.mjs');
  const session = runNode(hook, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'mcp-session', cwd: process.cwd() }), env)[0];
  const parent = session.hookSpecificOutput.additionalContext.match(/LYHNA_SESSION_CAPABILITY=([^\s.]+)/)[1];
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1' }, capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'begin_run', arguments: { session_capability: parent, mode: 'full', objective: 'MCP process test' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'record_claim', arguments: { session_capability: parent } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'record_claim', arguments: { session_capability: parent, statement: 123 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'record_claim', arguments: { session_capability: parent, statement: 'typed', evidence_refs: ['ok', 123] } } }
  ];
  const output = runNode(join(pluginRoot, 'src', 'mcp-server.mjs'), `${requests.map(JSON.stringify).join('\n')}\n`, env);
  const byId = Object.fromEntries(output.filter((item) => item.id !== undefined).map((item) => [item.id, item]));
  assert.equal(byId[1].result.serverInfo.name, 'lyhna-codex-adapter');
  assert.equal(byId[1].result.serverInfo.version, ADAPTER_VERSION);
  assert.equal(byId[2].result.tools.length, 13);
  assert.deepEqual(
    byId[2].result.tools.slice(-3).map((tool) => tool.name),
    ['declare_claim_contract', 'request_claim_producer', 'evaluate_claim_gate']
  );
  assert.equal(byId[3].result.structuredContent.status, 'OPEN');
  assert.equal(byId[4].error.message, 'INVALID_ARGUMENTS');
  assert.equal(byId[6].error.message, 'INVALID_ARGUMENTS');
  assert.equal(byId[7].error.message, 'INVALID_ARGUMENTS');
  const listOutput = runNode(join(pluginRoot, 'src', 'mcp-server.mjs'), `${JSON.stringify({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_child_receipts', arguments: { session_capability: parent } }
  })}\n`, env)[0];
  assert(!Array.isArray(listOutput.result.structuredContent));
  assert.deepEqual(listOutput.result.structuredContent.result, []);
});

test('lock file serializes concurrent processes without stealing a live owner', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const counterPath = join(data, 'lock-counter.txt');
  const ownerEnteredPath = join(data, 'owner-entered.txt');
  const lockPath = join(data, 'stress', '.lock');
  writeFileSync(counterPath, '0');
  const contenderSource = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => {
      const value = Number(readFileSync(process.env.COUNTER_PATH, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      writeFileSync(process.env.COUNTER_PATH, String(value + 1), { flush: true });
    });
  `;
  const ownerSource = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => {
      const value = Number(readFileSync(process.env.COUNTER_PATH, 'utf8'));
      writeFileSync(process.env.OWNER_ENTERED_PATH, 'yes', { flush: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      writeFileSync(process.env.COUNTER_PATH, String(value + 1), { flush: true });
    });
  `;
  const env = {
    ...process.env,
    LOCK_UTIL_URL: pathToFileURL(join(pluginRoot, 'src', 'util.mjs')).href,
    LOCK_PATH: lockPath,
    COUNTER_PATH: counterPath,
    OWNER_ENTERED_PATH: ownerEnteredPath
  };
  const ownerWorker = runNodeEval(ownerSource, env);
  for (let attempt = 0; attempt < 100 && !existsSync(ownerEnteredPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(ownerEnteredPath), true);
  await Promise.all([ownerWorker, ...Array.from({ length: 31 }, () => runNodeEval(contenderSource, env))]);
  assert.equal(Number(readFileSync(counterPath, 'utf8')), 32);
});

test('lock file reclaims an owner whose process exited inside the critical section', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const lockPath = join(data, 'crash', '.lock');
  const recoveredPath = join(data, 'recovered.txt');
  const env = {
    ...process.env,
    LOCK_UTIL_URL: pathToFileURL(join(pluginRoot, 'src', 'util.mjs')).href,
    LOCK_PATH: lockPath,
    RECOVERED_PATH: recoveredPath
  };
  await runNodeEval(`
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => process.exit(0));
  `, env);
  await runNodeEval(`
    import { writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => writeFileSync(process.env.RECOVERED_PATH, 'yes', { flush: true }));
  `, env);
  assert.equal(readFileSync(recoveredPath, 'utf8'), 'yes');
});

test('concurrent contenders recover a dead owner without overlapping critical sections', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const directory = join(data, 'crash-contention');
  const lockPath = join(directory, '.lock');
  const counterPath = join(data, 'crash-counter.txt');
  mkdirSync(directory, { recursive: true });
  writeFileSync(counterPath, '0');
  const env = {
    ...process.env,
    LOCK_UTIL_URL: pathToFileURL(join(pluginRoot, 'src', 'util.mjs')).href,
    LOCK_PATH: lockPath,
    COUNTER_PATH: counterPath
  };
  await runNodeEval(`
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => process.exit(0));
  `, env);
  const source = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => {
      const value = Number(readFileSync(process.env.COUNTER_PATH, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      writeFileSync(process.env.COUNTER_PATH, String(value + 1), { flush: true });
    });
  `;
  await Promise.all(Array.from({ length: 32 }, () => runNodeEval(source, env)));
  assert.equal(Number(readFileSync(counterPath, 'utf8')), 32);
  assert.deepEqual(readdirSync(directory), []);
});

test('lock file reclaims a dead recovery intent owner', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const directory = join(data, 'dead-election');
  const lockPath = join(directory, '.lock');
  const recoveredPath = join(data, 'dead-election-recovered.txt');
  mkdirSync(directory, { recursive: true });
  const deadOwner = JSON.stringify({ pid: 2147483646, token: 'dead-owner', acquired_at: '2000-01-01T00:00:00.000Z' });
  writeFileSync(lockPath, deadOwner);
  writeFileSync(`${lockPath}.recovery.2147483645.dead-recovery`, JSON.stringify({ pid: 2147483645, token: 'dead-recovery', acquired_at: '2000-01-01T00:00:00.000Z' }));
  await runNodeEval(`
    import { writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => writeFileSync(process.env.RECOVERED_PATH, 'yes', { flush: true }));
  `, {
    ...process.env,
    LOCK_UTIL_URL: pathToFileURL(join(pluginRoot, 'src', 'util.mjs')).href,
    LOCK_PATH: lockPath,
    RECOVERED_PATH: recoveredPath
  });
  assert.equal(readFileSync(recoveredPath, 'utf8'), 'yes');
});

test('lock file conservatively reclaims an ownerless legacy directory', { concurrency: false }, async (t) => {
  const data = isolatedData(t);
  const lockPath = join(data, 'legacy', '.lock');
  const recoveredPath = join(data, 'legacy-recovered.txt');
  mkdirSync(lockPath, { recursive: true });
  utimesSync(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
  await runNodeEval(`
    import { writeFileSync } from 'node:fs';
    const { withLock } = await import(process.env.LOCK_UTIL_URL);
    withLock(process.env.LOCK_PATH, () => writeFileSync(process.env.RECOVERED_PATH, 'yes', { flush: true }));
  `, {
    ...process.env,
    LOCK_UTIL_URL: pathToFileURL(join(pluginRoot, 'src', 'util.mjs')).href,
    LOCK_PATH: lockPath,
    RECOVERED_PATH: recoveredPath
  });
  assert.equal(readFileSync(recoveredPath, 'utf8'), 'yes');
});
