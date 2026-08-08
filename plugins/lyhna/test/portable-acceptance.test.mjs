import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const verifier = fileURLToPath(new URL(
  '../../../docs/acceptance/hetzner-v0.1.34-2026-08-08/verify.mjs',
  import.meta.url
));

test('the committed Hetzner acceptance packet remains independently verifiable', () => {
  const result = spawnSync(process.execPath, [verifier], {
    encoding: 'utf8',
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.source_implementation_pin, 'PASS');
  assert.equal(report.checks.exact_file_set, 'PASS');
  assert.equal(report.checks.ledger_chain, 'PASS');
  assert.equal(report.checks.canonical_state_hash, 'PASS');
  assert.equal(report.checks.receipt_refold, 'PASS');
  assert.equal(report.checks.continuation_refold, 'PASS');
  assert.equal(report.checks.handoff_refold, 'PASS');
  assert.equal(report.checks.capsule_signature, 'PASS');
  assert.equal(report.checks.proof_privacy_audit, 'PASS');
  assert.equal(report.checks.proof_narrative_allowlist, 'PASS');
  assert.deepEqual(report.checks.closeout_ordinals, [1, 1, 2, 3]);
  assert.equal(report.checks.terminal_status, 'CLOSED_UNSUPPORTED');
});
