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
// EVERY REPORT CARRIES EVERY CHECK. A check that could not be evaluated — because something it
// depends on failed first — is reported NOT RUN with its reason, never omitted. Dropping the row
// would let "we could not check this" read as "this did not apply", which is the same collapse
// UNRESOLVED_EVIDENCE exists to prevent one layer down. A reader comparing two reports should never
// see a row disappear.
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
import { verifyCapsuleSignature } from './signing.mjs';

const ZERO_HASH = '0'.repeat(64);

export const LINEAGE_TRUST_NOTICE =
  'This verifies internal consistency and the inheritance commitment between two packets. A valid '
  + 'signature proves the holder of that key folded exactly these bytes and that none has changed '
  + 'since — it does NOT prove the observations were true, and it does NOT defend against the key '
  + 'holder editing their own ledger before folding. Signing establishes integrity and continuity '
  + 'in transit and over time; it is not custody against the machine that produced the packet.';

/** Every check a complete report contains, in the order a reader reads them. */
const CHECK_SEQUENCE = [
  'prior_continuation_present',
  'prior_capsule_ref_self_consistent',
  'prior_state_hash_self_consistent',
  'prior_chain_valid',
  'prior_continuation_refolds',
  'prior_signature',
  'current_chain_valid',
  'current_declares_inheritance',
  'inheritance_capsule_ref_matches',
  'inheritance_state_hash_matches'
];

const NOT_RUN_DEFAULT = 'not run — an earlier check failed, so this could not be evaluated';

function check(name, ok, detail) {
  return { name, status: ok ? 'PASS' : 'FAIL', ok, detail };
}

/**
 * A check that never ran. `ok` stays false so the verdict fails safe: an unknown is not a pass,
 * even if a future caller reaches this state without an accompanying failure.
 */
function notRun(name, detail) {
  return { name, status: 'NOT_RUN', ok: false, detail };
}

/**
 * Emit the full sequence — recorded results in place, NOT RUN for everything that never got there —
 * and decide the verdict. Only a PASS counts as a pass.
 */
function finalize(report, recorded) {
  const byName = new Map(recorded.map((item) => [item.name, item]));
  report.checks = CHECK_SEQUENCE.map((name) => byName.get(name) ?? notRun(name, NOT_RUN_DEFAULT));
  report.ok = report.checks.every((item) => item.status === 'PASS');
  return report;
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
    prior_signed_by: null,
    current_run_id: null,
    checks,
    trust_notice: LINEAGE_TRUST_NOTICE
  };

  const priorContinuationPath = join(priorDirectory, 'continuation.json');
  if (!existsSync(priorContinuationPath)) {
    checks.push(check('prior_continuation_present', false, 'prior packet has no continuation.json'));
    return finalize(report, checks);
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
      // Compare WITHOUT the signature block: a fresh fold has no signature, and the signature is
      // checked separately below. Stripping it here keeps the re-fold a test of the CONTENT.
      const { signature: _publishedSignature, ...publishedCore } = published;
      const { signature: _refoldedSignature, ...refoldedCore } = refolded;
      const matches = canonicalJson(refoldedCore) === canonicalJson(publishedCore);
      checks.push(check(
        'prior_continuation_refolds',
        matches,
        matches ? 're-folding the prior ledger reproduces the published continuation exactly' : 'the published continuation does not match a fresh fold of its own ledger'
      ));
    }
  } else {
    checks.push(notRun(
      'prior_continuation_refolds',
      'not run — the prior ledger does not chain-validate, so there is no trustworthy fold to compare against'
    ));
  }

  // Signature: who folded this, and has a byte changed since. An UNSIGNED capsule is reported as
  // such rather than failed — a packet can be complete and hash-verifiable without a key, and
  // calling that tampered would be the overclaim. A signature that is PRESENT and BAD does fail.
  const signatureResult = verifyCapsuleSignature(published);
  report.prior_signed_by = signatureResult.public_key;
  if (!published.signature) {
    checks.push(check('prior_signature', true, 'unsigned capsule — identity not attested, content still hash-verified'));
  } else {
    checks.push(check('prior_signature', signatureResult.ok, `${signatureResult.reason} (key_id ${signatureResult.key_id})`));
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
      for (const name of ['inheritance_capsule_ref_matches', 'inheritance_state_hash_matches']) {
        checks.push(notRun(name, 'not run — the current packet declares no inheritance edge to compare'));
      }
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

  return finalize(report, checks);
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
    `- Signed by: ${report.prior_signed_by ? `\`${report.prior_signed_by}\`` : '_unsigned_'}`,
    '',
    '## Checks',
    ''
  ];
  for (const item of report.checks) lines.push(`- ${(item.status ?? (item.ok ? 'PASS' : 'FAIL')).replace('_', ' ')} — \`${item.name}\`: ${item.detail}`);
  lines.push('', '## Trust boundary', '', report.trust_notice, '');
  lines.push('', 'A signature proves who folded a capsule and that it has not changed since. It does not', 'make the observations true.', '');
  return `${lines.join('\n')}\n`;
}
