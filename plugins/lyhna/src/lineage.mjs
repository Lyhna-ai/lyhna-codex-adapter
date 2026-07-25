// Lineage verification — prove that window N+1 actually inherited window N.
//
// A single handoff can be checked by reading it. A CHAIN of handoffs cannot: by the fourth or
// fifth window the human has no way to tell whether the thread is still describing the same work,
// because every link was written by an agent summarizing a summary. Drift compounds silently, and
// the only people equipped to notice are the ones who least need the tool.
//
// This checker re-derives the inheritance claim from the artifacts alone, without trusting the
// process that wrote them:
//
//   1. the prior packet's published continuation.json recomputes its own capsule_ref and
//      state_hash (self-consistency);
//   2. the prior packet's ledger chain-validates independently — every event_hash recomputed,
//      every prev_hash linked (the trust root is the chain, not the rendered file);
//   3. re-folding the prior packet's ledger reproduces the published continuation byte-for-byte
//      (NON-CIRCULAR: the published capsule is not taken on faith, it is re-derived);
//   4. the current packet's ledger chain-validates, and its run_begun event — inside that chain —
//      commits to exactly the prior capsule_ref and state_hash.
//
// Pure, local, deterministic: it reads two directories, computes, and returns a report. No network,
// no subprocess, no clock.
//
// TRUST BOUNDARY (stated in every report, pass or fail): this is a LOCAL STRUCTURAL check. As SPEC
// states for the ledger itself, "append-only", "sealed", and "cannot rewrite" are logical local-store
// properties, not adversary-resistant claims against an agent with unrestricted filesystem access.
// A lineage PASS means the two packets are internally consistent and genuinely linked. It does not
// mean cryptographic custody, and it must never be reported as such.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256 } from './util.mjs';
import { buildContinuation, buildCarryForward, deriveCapsuleRef } from './continuation.mjs';

const ZERO_HASH = '0'.repeat(64);

export const LINEAGE_TRUST_NOTICE =
  'Local structural check only. This verifies internal consistency and the inheritance commitment '
  + 'between two packets; it is not cryptographic custody and does not prove the packets were never '
  + 'edited by a process with filesystem access.';

function check(name, ok, detail) {
  return { name, ok, detail };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Independently re-walk a ledger file: recompute every event hash from its own content and confirm
 * each link. Deliberately does NOT import the store's reader — a checker that trusts the writer's
 * reader is not a check.
 */
export function verifyLedgerChain(directory) {
  const path = join(directory, 'events.jsonl');
  if (!existsSync(path)) return { ok: false, detail: 'events.jsonl is missing', events: [], tip: null };
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
  const events = [];
  let previous = ZERO_HASH;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, detail: `event ${index + 1} is not valid JSON`, events, tip: previous };
    }
    const claimed = event.event_hash;
    const withoutHash = { ...event };
    delete withoutHash.event_hash;
    const expected = sha256(canonicalJson(withoutHash));
    if (event.seq !== index + 1) return { ok: false, detail: `event ${index + 1} has out-of-order seq ${event.seq}`, events, tip: previous };
    if (event.prev_hash !== previous) return { ok: false, detail: `event ${event.seq} does not link to its predecessor`, events, tip: previous };
    if (claimed !== expected) return { ok: false, detail: `event ${event.seq} hash does not match its content`, events, tip: previous };
    previous = claimed;
    events.push(event);
  }
  return { ok: true, detail: `${events.length} event(s) chain-validated`, events, tip: previous };
}

/** Re-fold a packet's ledger into a continuation capsule, independent of whatever it published. */
function refoldContinuation(directory, events) {
  const statePath = join(directory, 'state.json');
  if (!existsSync(statePath)) return null;
  return buildContinuation(readJsonFile(statePath), events);
}

/**
 * @param priorDirectory   run packet directory of the EARLIER window
 * @param currentDirectory run packet directory of the window that claims to continue it
 */
export function verifyLineage(priorDirectory, currentDirectory) {
  const checks = [];
  const report = {
    schema: 'lyhna.codex.lineage.v0',
    ok: false,
    prior_packet: priorDirectory,
    current_packet: currentDirectory,
    prior_capsule_ref: null,
    current_run_id: null,
    checks,
    trust_notice: LINEAGE_TRUST_NOTICE
  };

  const priorContinuationPath = join(priorDirectory, 'continuation.json');
  if (!existsSync(priorContinuationPath)) {
    checks.push(check('prior_continuation_present', false, 'prior packet has no continuation.json'));
    return report;
  }
  const published = readJsonFile(priorContinuationPath);
  report.prior_capsule_ref = published.capsule_ref ?? null;
  checks.push(check('prior_continuation_present', true, `capsule_ref ${published.capsule_ref}`));

  // 1. Self-consistency — the published capsule agrees with its own declared identity.
  const recomputedRef = deriveCapsuleRef(published);
  checks.push(check(
    'prior_capsule_ref_self_consistent',
    recomputedRef === published.capsule_ref,
    recomputedRef === published.capsule_ref ? 'capsule_ref recomputes from its own content' : `capsule_ref mismatch: content hashes to ${recomputedRef}`
  ));
  const recomputedStateHash = sha256(canonicalJson(buildCarryForward(published)));
  checks.push(check(
    'prior_state_hash_self_consistent',
    recomputedStateHash === published.state_hash,
    recomputedStateHash === published.state_hash ? 'state_hash recomputes from the carry-forward core' : `state_hash mismatch: core hashes to ${recomputedStateHash}`
  ));

  // 2. The prior packet's chain is the trust root, not its rendered files.
  const priorChain = verifyLedgerChain(priorDirectory);
  checks.push(check('prior_chain_valid', priorChain.ok, priorChain.detail));

  // 3. Non-circular value binding — re-derive rather than believe.
  if (priorChain.ok) {
    const refolded = refoldContinuation(priorDirectory, priorChain.events);
    if (!refolded) {
      checks.push(check('prior_continuation_refolds', false, 'prior packet has no state.json to re-fold from'));
    } else {
      const matches = canonicalJson(refolded) === canonicalJson(published);
      checks.push(check(
        'prior_continuation_refolds',
        matches,
        matches ? 're-folding the prior ledger reproduces the published continuation exactly' : 'the published continuation does not match a fresh fold of its own ledger'
      ));
    }
  }

  // 4. The current packet's inheritance commitment, read from inside its own hash chain.
  const currentChain = verifyLedgerChain(currentDirectory);
  checks.push(check('current_chain_valid', currentChain.ok, currentChain.detail));
  if (currentChain.ok) {
    const runBegun = currentChain.events.find((event) => event.type === 'run_begun');
    report.current_run_id = runBegun ? currentChain.events[0]?.run_id ?? null : null;
    const inherits = runBegun?.payload?.inherits || null;
    if (!inherits) {
      checks.push(check('current_declares_inheritance', false, 'the current packet\'s run_begun event declares no inherits edge'));
    } else {
      checks.push(check('current_declares_inheritance', true, `declares capsule_ref ${inherits.capsule_ref}`));
      checks.push(check(
        'inheritance_capsule_ref_matches',
        inherits.capsule_ref === published.capsule_ref,
        inherits.capsule_ref === published.capsule_ref
          ? 'the committed capsule_ref is the prior packet\'s capsule'
          : `committed capsule_ref ${inherits.capsule_ref} is not the prior packet's ${published.capsule_ref}`
      ));
      checks.push(check(
        'inheritance_state_hash_matches',
        inherits.state_hash === published.state_hash,
        inherits.state_hash === published.state_hash
          ? 'the committed state_hash is the prior packet\'s carry-forward state'
          : `committed state_hash ${inherits.state_hash} is not the prior packet's ${published.state_hash}`
      ));
    }
  }

  report.ok = checks.every((item) => item.ok);
  return report;
}

/** Human-readable projection. Deterministic: a pure function of the report. */
export function renderLineageMarkdown(report) {
  const lines = [
    '# Lineage check — did the next window actually inherit this one?',
    '',
    `- Result: **${report.ok ? 'LINKED' : 'NOT LINKED'}**`,
    `- Prior packet: \`${report.prior_packet}\``,
    `- Current packet: \`${report.current_packet}\``,
    `- Prior capsule ref: \`${report.prior_capsule_ref ?? 'none'}\``,
    '',
    '## Checks',
    ''
  ];
  for (const item of report.checks) lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} — \`${item.name}\`: ${item.detail}`);
  lines.push('', '## Trust boundary', '', report.trust_notice, '');
  return `${lines.join('\n')}\n`;
}
