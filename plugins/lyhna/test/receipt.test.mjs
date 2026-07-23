import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReceipt, renderReceiptJson, renderReceiptMarkdown } from '../src/receipt.mjs';

const fixedState = {
  id: 'run_fixed',
  mode: 'pr_only',
  sealed: true,
  objective: 'Examine the PR.',
  objective_origin: 'agent_reported',
  configured_hooks: ['SessionStart'],
  pr_snapshots: {},
  evaluations: {},
  child_receipts: {}
};

test('identical normalized receipt input is byte-identical and PR-only limitation is explicit', () => {
  const events = [{ seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: { mode: 'pr_only' } }];
  assert.equal(renderReceiptJson(fixedState, events), renderReceiptJson(structuredClone(fixedState), structuredClone(events)));
  assert.equal(renderReceiptMarkdown(fixedState, events), renderReceiptMarkdown(structuredClone(fixedState), structuredClone(events)));
  const parsed = JSON.parse(renderReceiptJson(fixedState, events));
  assert.equal(parsed.build_record, 'unavailable');
  assert.equal(parsed.evidence[0].ref, `sha256:${'a'.repeat(64)}`);
  assert(parsed.limitations.some((item) => /No witnessed build record/.test(item)));
  assert.match(renderReceiptMarkdown(fixedState, events), /Build record: \*\*unavailable\*\*/);
  assert.match(renderReceiptMarkdown(fixedState, events), /## Child receipts\n\n- None recorded\./);
  const withChild = {
    ...fixedState,
    child_receipts: {
      child_agent_fixed: { id: 'child_agent_fixed', role: 'delegated_agent', status: 'STOP_OBSERVED', retrieved: false }
    }
  };
  assert.match(renderReceiptMarkdown(withChild, events), /`child_agent_fixed` \(delegated_agent\): \*\*STOP_OBSERVED\*\*; retrieved: \*\*no\*\*/);
});

// CZ-14: the lifecycle face renders exactly one of three observational shapes.
test('the lifecycle face renders SEALED, OPEN, and close-requested-not-sealed shapes', () => {
  const sealedEvents = [{ seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: {} }];
  const sealed = buildReceipt(fixedState, sealedEvents);
  assert.equal(sealed.lifecycle.status, 'SEALED');
  assert.match(renderReceiptMarkdown(fixedState, sealedEvents), /## Lifecycle\n\n- Lifecycle status: \*\*SEALED\*\*/);

  const openState = { ...fixedState, sealed: false, ledger_count: 2 };
  const openEvents = [
    { seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: {} },
    { seq: 2, event_hash: 'b'.repeat(64), type: 'turn_checkpoint', origin: 'runtime_hook', payload: { status: 'OPEN', receipt_renderer: '0.1.27' } }
  ];
  const open = buildReceipt(openState, openEvents);
  assert.equal(open.lifecycle.status, 'OPEN');
  assert.equal(open.lifecycle.statement, 'OPEN as of event 2 — no close request observed.');
  assert(!/abandon/i.test(renderReceiptMarkdown(openState, openEvents)));

  const closeState = { ...fixedState, sealed: false, ledger_count: 3, close_requested: { reason: 'x' } };
  const closeEvents = [
    { seq: 1, event_hash: 'a'.repeat(64), type: 'run_begun', origin: 'mcp_routed', payload: {} },
    { seq: 2, event_hash: 'b'.repeat(64), type: 'close_requested', origin: 'mcp_routed', payload: { reason: 'x' } },
    { seq: 3, event_hash: 'c'.repeat(64), type: 'close_deferred', origin: 'runtime_hook', payload: { blockers: ['PR_SNAPSHOT_REQUIRED'], receipt_renderer: '0.1.27' } }
  ];
  const closeReq = buildReceipt(closeState, closeEvents);
  assert.equal(closeReq.lifecycle.status, 'CLOSE_REQUESTED_NOT_SEALED');
  assert.equal(closeReq.lifecycle.close_requested_seq, 2);
  assert.match(closeReq.lifecycle.statement, /A close was requested at event 2; the run had not sealed as of this checkpoint \(event 3\)\./);
  assert.deepEqual(closeReq.lifecycle.blockers_observed.map((blocker) => blocker.code), ['PR_SNAPSHOT_REQUIRED']);
  const closeMarkdown = renderReceiptMarkdown(closeState, closeEvents);
  assert.match(closeMarkdown, /Lifecycle status: \*\*CLOSE_REQUESTED_NOT_SEALED\*\*/);
  assert.match(closeMarkdown, /Open closeout conditions observed as of this checkpoint:/);
  assert.match(closeMarkdown, /PR_SNAPSHOT_REQUIRED/);
});
