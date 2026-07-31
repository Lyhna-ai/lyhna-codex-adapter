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
import { buildContinuation, buildCarryForward, deriveCapsuleRef, CURRENT_FOLD_VERSION, KNOWN_FOLD_VERSIONS, foldCandidatesForRenderer } from './continuation.mjs';
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
  const remaining = [...recorded];
  const take = (name) => {
    const index = remaining.findIndex((item) => item.name === name);
    return index === -1 ? null : remaining.splice(index, 1)[0];
  };
  report.checks = CHECK_SEQUENCE.map((name) => take(name) ?? notRun(name, NOT_RUN_DEFAULT));
  // Anything left over is APPENDED, never dropped: a check recorded under a name the sequence does
  // not know, or one recorded twice. Projecting the sequence onto the recorded results would have
  // discarded those rows — including a FAIL — and a discarded FAIL reads as LINKED. The function
  // whose whole job is that no row disappears must not be the thing that disappears one.
  report.checks.push(...remaining);
  report.ok = report.checks.every((item) => item.status === 'PASS');
  return report;
}

/**
 * Read a JSON object, REPORTING a file that is missing, empty, malformed, or not an object rather
 * than throwing out of the checker. A one-byte truncation of a packet is exactly the tamper this
 * tool exists to catch; it must produce a recorded FAIL, not a stack trace and no report at all.
 */
function readJsonObject(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, detail: `cannot be read (${error.code ?? 'unknown error'})`, value: null };
  }
  if (!raw.trim()) return { ok: false, detail: 'is empty', value: null };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, detail: 'is not valid JSON', value: null };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'is not a JSON object', value: null };
  }
  return { ok: true, detail: 'read', value };
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
  // An emptied ledger is a destroyed chain, not a valid one of length zero. Reporting "0 event(s)
  // chain-validated" as a PASS would let wholesale deletion read as intact — the same collapse this
  // file exists to prevent, one level down. Every real packet opens with run_begun.
  if (lines.length === 0) return { ok: false, detail: 'events.jsonl is empty — there is no chain to validate', events: [], tip: null };
  const events = [];
  let previous = ZERO_HASH;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, detail: `event ${index + 1} is not valid JSON`, events, tip: previous };
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return { ok: false, detail: `event ${index + 1} is not a JSON object`, events, tip: previous };
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
function refoldContinuation(directory, events, foldVersion) {
  const statePath = join(directory, 'state.json');
  if (!existsSync(statePath)) return { ok: false, detail: 'prior packet has no state.json to re-fold from', value: null };
  const state = readJsonObject(statePath);
  if (!state.ok) return { ok: false, detail: `prior packet's state.json ${state.detail}, so there is nothing to re-fold`, value: null };
  return { ok: true, detail: 'read', value: buildContinuation(state.value, events, foldVersion) };
}

/**
 * Which fold generation wrote this packet.
 *
 * Read from the HASH-CHAINED anchor (`run_sealed`, else the latest `checkpoint_anchor`), never from
 * the capsule. The capsule is deliberately unanchored, so a `continuation_fold_version` field read
 * from it would let a forged packet select the reducer under which it verifies — the same
 * cache-selects-a-weaker-path defect this codebase has closed twice elsewhere.
 *
 * An adapter version we have no reducer for is reported, never guessed at with current code.
 */
function foldVersionForPacket(events) {
  const sealed = events.find((event) => event.type === 'run_sealed');
  const anchor = sealed || [...events].reverse().find((event) => event.type === 'checkpoint_anchor');
  if (!anchor) return { ok: false, version: null, renderer: null, detail: 'the prior ledger commits to no anchor, so its fold generation is unknown' };
  const renderer = anchor.payload?.receipt_renderer ?? null;
  // First choice: the fold generation the chain itself commits to (0.1.32 onward writes it into
  // the anchor payload). A declared generation this checker does not implement is reported, never
  // approximated with current code.
  const declared = anchor.payload?.continuation_fold_version;
  if (declared !== undefined) {
    if (!KNOWN_FOLD_VERSIONS.includes(declared)) {
      return { ok: false, candidates: null, renderer, detail: `the prior ledger commits to fold generation "${declared}", which this checker does not implement` };
    }
    return { ok: true, candidates: [declared], renderer, detail: `chained fold ${declared}` };
  }
  // No chained declaration: a historical packet. Dispatch ONLY off the closed whitelist of
  // renderers that actually shipped before the field existed. No range inference — an open-ended
  // "anything below X is v0, anything else is current" rule silently folds a renderer from the
  // future with today's reducer, which is the one outcome that must never happen. A renderer may
  // map to MORE THAN ONE shipped shape (0.1.30 changed its carry-forward mid-version, before the
  // release): the packet's own bytes pick between them, and the report states which matched.
  const candidates = foldCandidatesForRenderer(renderer);
  if (!candidates) {
    return { ok: false, candidates: null, renderer, detail: `the prior ledger commits to renderer "${renderer ?? 'none'}" with no fold declaration, which this checker cannot place` };
  }
  return { ok: true, candidates, renderer, detail: `renderer ${renderer} → fold candidate(s) ${candidates.join(', ')}` };
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
    prior_fold_version: null,
    prior_renderer: null,
    prior_claim_semantics: null,
    inherited_fold_version: null,
    current_run_id: null,
    checks,
    trust_notice: LINEAGE_TRUST_NOTICE
  };

  const priorContinuationPath = join(priorDirectory, 'continuation.json');
  if (!existsSync(priorContinuationPath)) {
    checks.push(check('prior_continuation_present', false, 'prior packet has no continuation.json'));
    return finalize(report, checks);
  }
  const publishedRead = readJsonObject(priorContinuationPath);
  if (!publishedRead.ok) {
    checks.push(check('prior_continuation_present', false, `prior packet's continuation.json ${publishedRead.detail}`));
    return finalize(report, checks);
  }
  const published = publishedRead.value;
  report.prior_capsule_ref = published.capsule_ref ?? null;
  checks.push(check('prior_continuation_present', true, `capsule_ref ${published.capsule_ref}`));

  // 1. Self-consistency — the published capsule agrees with its own declared identity.
  const recomputedRef = deriveCapsuleRef(published);
  checks.push(check(
    'prior_capsule_ref_self_consistent',
    recomputedRef === published.capsule_ref,
    recomputedRef === published.capsule_ref ? 'capsule_ref recomputes from its own content' : `capsule_ref mismatch: content hashes to ${recomputedRef}`
  ));
  // 2. The prior packet's chain is the trust root, not its rendered files. Resolve its fold before
  // checking state_hash: shipped generations hashed different carry-forward shapes, and the
  // unanchored capsule must never select the reducer used to validate itself.
  const priorChain = verifyLedgerChain(priorDirectory);
  const fold = priorChain.ok
    ? foldVersionForPacket(priorChain.events)
    : { ok: false, candidates: null, renderer: null, detail: 'the prior ledger does not chain-validate' };
  // Where a renderer maps to several shipped shapes, the packet's own bytes decide which one wrote
  // it: the matched generation is the candidate whose refold reproduces the published capsule.
  // Matching runs once here and feeds both the state-hash and refold rows, so the two can never
  // disagree about which generation they judged the packet under.
  let matchedFold = null;
  let refoldOutcome = null;
  if (priorChain.ok && fold.ok) {
    for (const candidate of fold.candidates) {
      const refolded = refoldContinuation(priorDirectory, priorChain.events, candidate);
      if (!refolded.ok) { refoldOutcome = refolded; break; }
      const { signature: _publishedSignature, ...publishedCore } = published;
      const { signature: _refoldedSignature, ...refoldedCore } = refolded.value;
      if (canonicalJson(refoldedCore) === canonicalJson(publishedCore)) {
        matchedFold = candidate;
        break;
      }
    }
  }
  const judgedFold = matchedFold ?? fold.candidates?.[0] ?? null;
  report.prior_fold_version = matchedFold ?? (fold.ok ? fold.candidates.join('|') : null);
  report.prior_renderer = fold.renderer;
  report.prior_claim_semantics = judgedFold === null ? null : judgedFold === CURRENT_FOLD_VERSION ? 'CURRENT' : 'SUPERSEDED';
  if (!priorChain.ok || !fold.ok) {
    checks.push(notRun('prior_state_hash_self_consistent', `not run — ${fold.detail}`));
  } else {
    const recomputedStateHash = sha256(canonicalJson(buildCarryForward(published, judgedFold)));
    checks.push(check(
      'prior_state_hash_self_consistent',
      recomputedStateHash === published.state_hash,
      recomputedStateHash === published.state_hash
        ? `state_hash recomputes from the carry-forward core (fold ${judgedFold})`
        : `state_hash mismatch under fold ${judgedFold}: core hashes to ${recomputedStateHash}`
    ));
  }
  checks.push(check('prior_chain_valid', priorChain.ok, priorChain.detail));

  // 3. Non-circular value binding — re-derive rather than believe.
  //
  // Two separate questions, deliberately not conflated: does this packet reproduce the fold it
  // declared (historical integrity), and do its claim labels still mean what today's rules mean
  // (current-policy trust)? A packet written by an older fold can be perfectly intact and still
  // carry labels this build would not issue. Only the first gates the verdict.
  if (priorChain.ok && !fold.ok) {
    checks.push(notRun('prior_continuation_refolds', `not run — ${fold.detail}`));
  } else if (priorChain.ok) {
    // The candidate matching above already re-folded and compared without the signature block — a
    // fresh fold has no signature and the signature is checked separately below, so the re-fold
    // stays a test of the CONTENT.
    if (refoldOutcome && !refoldOutcome.ok) {
      checks.push(check('prior_continuation_refolds', false, refoldOutcome.detail));
    } else {
      checks.push(check(
        'prior_continuation_refolds',
        matchedFold !== null,
        matchedFold !== null
          ? `re-folding the prior ledger under fold ${matchedFold} reproduces the published continuation exactly`
          : `the published continuation does not match a fresh fold of its own ledger under any candidate generation (tried ${fold.candidates.join(', ')})`
      ));
    }
  } else {
    checks.push(notRun(
      'prior_continuation_refolds',
      'not run — the prior ledger does not chain-validate, so there is no trustworthy fold to compare against'
    ));
  }

  // Read the successor chain now so signature verification can target the capsule it ACTUALLY
  // inherited. The check row remains later in the fixed report order; computing the input early
  // does not make an invalid current chain pass.
  const currentChain = verifyLedgerChain(currentDirectory);
  const currentRunBegun = currentChain.ok
    ? currentChain.events.find((event) => event.type === 'run_begun')
    : null;
  const currentInherits = currentRunBegun?.payload?.inherits || null;
  let inheritanceTarget = published;
  let inheritanceVia = 'the prior packet\'s capsule';
  if (currentInherits && currentInherits.capsule_ref !== published.capsule_ref) {
    const archivePath = join(priorDirectory, 'capsules', `${currentInherits.capsule_ref}.json`);
    if (existsSync(archivePath)) {
      const archived = readJsonObject(archivePath);
      // The content-addressed ref authenticates what the archive IS; it says nothing about WHOSE
      // it is. A valid, signed archive copied from another run's packet passes the ref and
      // signature checks perfectly — so the archive must also be bound to THIS packet's ledger:
      // its run_id must be the prior chain's run_id, and the ledger tip it committed to must
      // actually appear at the position it names in this chain. Both fields live inside the bytes
      // the committed ref covers, so a forger cannot adjust them without breaking the ref match.
      if (archived.ok && deriveCapsuleRef(archived.value) === currentInherits.capsule_ref) {
        const archivedCount = archived.value.witnessed?.event_count;
        const archivedTip = archived.value.witnessed?.ledger_tip;
        // The decisive bond: the ledger tip this fold committed to must actually BE the event hash
        // at the position it names in THIS packet's chain. Hash chains from different runs share no
        // event hashes, so a planted archive cannot satisfy this. run_id is cross-checked against
        // the published capsule (itself refold-verified against this ledger) as a second stitch.
        const prefixTipMatches = priorChain.ok
          && Number.isInteger(archivedCount)
          && archivedCount >= 1
          && archivedCount <= priorChain.events.length
          && priorChain.events[archivedCount - 1]?.event_hash === archivedTip;
        if (archived.value.run_id === published.run_id && prefixTipMatches) {
          inheritanceTarget = archived.value;
          // Classify the inherited capsule from ITS OWN anchor — the event its fold rode on, which
          // by the tip binding is exactly the event at the position it names. A packet can span
          // fold generations (a v0 checkpoint, an upgrade, a v1 face): the face's classification
          // must not speak for the archive, or a legacy inherited capsule reads as current and the
          // superseded-semantics warning about its claims is silently suppressed.
          const inheritedAnchor = priorChain.events[archivedCount - 1];
          const declaredInherited = inheritedAnchor?.payload?.continuation_fold_version;
          let inheritedFold = null;
          if (declaredInherited !== undefined) {
            inheritedFold = KNOWN_FOLD_VERSIONS.includes(declaredInherited) ? declaredInherited : null;
          } else {
            const inheritedCandidates = foldCandidatesForRenderer(inheritedAnchor?.payload?.receipt_renderer);
            inheritedFold = inheritedCandidates ? (inheritedCandidates.length === 1 ? inheritedCandidates[0] : inheritedCandidates.join('|')) : null;
          }
          report.inherited_fold_version = inheritedFold;
          if (inheritedFold !== CURRENT_FOLD_VERSION) report.prior_claim_semantics = 'SUPERSEDED';
          inheritanceVia = `an archived fold this run later superseded (content-addressed; bound to this ledger at event ${archivedCount}; inherited fold ${inheritedFold ?? 'unknown'})`;
        }
      }
    }
  }

  // Signature: who folded the capsule selected by the successor, and has a byte changed since. An
  // UNSIGNED capsule is reported as such rather than failed — a packet can be complete and
  // hash-verifiable without a key, and calling that tampered would be the overclaim. A signature
  // that is PRESENT and BAD does fail.
  const signatureResult = verifyCapsuleSignature(inheritanceTarget);
  report.prior_signed_by = signatureResult.public_key;
  if (!inheritanceTarget.signature) {
    checks.push(check('prior_signature', true, `unsigned capsule — identity not attested, content still hash-verified (${inheritanceVia})`));
  } else {
    checks.push(check('prior_signature', signatureResult.ok, `${signatureResult.reason} (key_id ${signatureResult.key_id}; ${inheritanceVia})`));
  }

  // 4. The current packet's inheritance commitment, read from inside its own hash chain.
  checks.push(check('current_chain_valid', currentChain.ok, currentChain.detail));
  if (currentChain.ok) {
    const runBegun = currentRunBegun;
    report.current_run_id = runBegun ? currentChain.events[0]?.run_id ?? null : null;
    const inherits = runBegun?.payload?.inherits || null;
    if (!inherits) {
      checks.push(check('current_declares_inheritance', false, 'the current packet\'s run_begun event declares no inherits edge'));
      for (const name of ['inheritance_capsule_ref_matches', 'inheritance_state_hash_matches']) {
        checks.push(notRun(name, 'not run — the current packet declares no inheritance edge to compare'));
      }
    } else {
      checks.push(check('current_declares_inheritance', true, `declares capsule_ref ${inherits.capsule_ref}`));
      // The prior run may have kept working after this handoff was taken: continuation.json is the
      // run's CURRENT face, and every fold is also archived immutably under its content-addressed
      // ref. An archived capsule whose bytes hash to the committed ref IS that capsule — accepting
      // it invents nothing, because forging the file would require content hashing to a ref the
      // successor already sealed into its own chain. The comparison target is therefore the
      // committed fold, current or archived; which one it was is stated, not hidden.
      const target = inheritanceTarget;
      const via = inheritanceVia;
      checks.push(check(
        'inheritance_capsule_ref_matches',
        inherits.capsule_ref === target.capsule_ref,
        inherits.capsule_ref === target.capsule_ref
          ? `the committed capsule_ref is ${via}`
          : `committed capsule_ref ${inherits.capsule_ref} is not the prior packet's ${published.capsule_ref}, and no archived fold matches it`
      ));
      checks.push(check(
        'inheritance_state_hash_matches',
        inherits.state_hash === target.state_hash,
        inherits.state_hash === target.state_hash
          ? `the committed state_hash is the carry-forward state of ${via}`
          : `committed state_hash ${inherits.state_hash} is not the prior packet's ${target.state_hash}`
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
    `- Prior fold: ${report.prior_fold_version ? `\`${report.prior_fold_version}\` (renderer ${report.prior_renderer})` : '_unknown_'}`,
    ...(report.prior_claim_semantics === 'SUPERSEDED'
      ? ['', '> **Claim labels in the prior packet were written under superseded semantics.** That packet'
          + ' is re-folded and verified under the rules it was written by, so a LINKED result here is a'
          + ' statement about its integrity, not an endorsement of its labels. Under current rules a cited'
          + ' reference is only ever reported as resolving, never as supporting a claim, and no builder'
          + ' claim is promoted into `settled`. Re-read those claims before relying on them.']
      : []),
    '',
    '## Checks',
    ''
  ];
  for (const item of report.checks) lines.push(`- ${(item.status ?? (item.ok ? 'PASS' : 'FAIL')).replaceAll('_', ' ')} — \`${item.name}\`: ${item.detail}`);
  lines.push('', '## Trust boundary', '', report.trust_notice, '');
  lines.push('', 'A signature proves who folded a capsule and that it has not changed since. It does not', 'make the observations true.', '');
  return `${lines.join('\n')}\n`;
}
