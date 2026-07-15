import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { beginRun, getRunForTesting } from '../src/store.mjs';
import { isolatedData } from './helpers.mjs';

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
  const pre = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'live-session', tool_name: 'exec_command', tool_use_id: 'same-delivery' });
  runNode(hook, pre, env);
  runNode(hook, pre, env);
  runNode(hook, JSON.stringify({ hook_event_name: 'Stop', session_id: 'live-session', event_id: 'stop-1' }), env);
  runNode(hook, JSON.stringify({ hook_event_name: 'Stop', session_id: 'live-session', event_id: 'stop-1' }), env);
  const events = getRunForTesting(run.id).events;
  assert.equal(events.filter((event) => event.payload?.event_id === 'same-delivery').length, 1);
  assert.equal(events.filter((event) => event.type === 'turn_checkpoint').length, 1);
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
  assert.equal(byId[2].result.tools.length, 10);
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
