import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReceiptJson, renderReceiptMarkdown } from '../src/receipt.mjs';

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
  const events = [{ seq: 1, type: 'run_begun', origin: 'mcp_routed', payload: { mode: 'pr_only' } }];
  assert.equal(renderReceiptJson(fixedState, events), renderReceiptJson(structuredClone(fixedState), structuredClone(events)));
  assert.equal(renderReceiptMarkdown(fixedState, events), renderReceiptMarkdown(structuredClone(fixedState), structuredClone(events)));
  const parsed = JSON.parse(renderReceiptJson(fixedState, events));
  assert.equal(parsed.build_record, 'unavailable');
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
