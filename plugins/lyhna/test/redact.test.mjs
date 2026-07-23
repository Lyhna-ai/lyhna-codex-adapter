import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedText, safeSummary, sanitizeClaim, sanitizeHook } from '../src/redact.mjs';

test('hook and object summaries exclude secret values and full tool output', () => {
  const secret = 'github_pat_1234567890abcdefghijklmnopqrstuvwxyz';
  const summary = safeSummary({ authorization: `Bearer ${secret}`, output: `result ${secret}`, safe: 'ok' });
  const serialized = JSON.stringify(summary);
  assert(!serialized.includes(secret));
  assert(serialized.includes('[REDACTED]'));
  const hook = sanitizeHook({ hook_event_name: 'PostToolUse', tool_name: 'exec_command', output: secret, status: 'failed' });
  assert(!JSON.stringify(hook).includes(secret));
  assert.equal(hook.support, 'tool_returned');
  assert.equal(hook.outcome, 'failed');
});

test('generic assigned credentials, Basic authorization, and capabilities are redacted', () => {
  const text = boundedText('password=hunter2 Authorization: Basic dXNlcjpwYXNz lyhna_session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa postgresql://adam:hunter2@localhost/db AKIAIOSFODNN7EXAMPLE', 500);
  assert(!text.includes('hunter2'));
  assert(!text.includes('dXNlcjpwYXNz'));
  assert(!text.includes('lyhna_session_'));
  assert(!text.includes('postgresql://'));
  assert(!text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[REDACTED_CAPABILITY\]/);
});

test('normalized evidence digests remain joinable while raw references are hashed', () => {
  const digest = 'a'.repeat(64);
  const claim = sanitizeClaim('Supported claim.', [digest, `sha256:${digest}`, 'artifact:test-output']);
  assert.equal(claim.evidence_refs.filter((item) => item === `sha256:${digest}`).length, 1);
  assert.equal(claim.evidence_refs.length, 2);
  assert(claim.evidence_refs.every((item) => /^sha256:[a-f0-9]{64}$/.test(item)));
});
