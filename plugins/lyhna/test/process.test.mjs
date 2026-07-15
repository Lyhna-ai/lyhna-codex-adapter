import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
