import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText, assert, canonicalJson, dataRoot, ORIGINS, readJson, sha256, withLock } from './util.mjs';
import { boundedText, promptSynopsis, reference, sanitizeClaim, structuralSummary } from './redact.mjs';
import { renderReceiptJson, renderReceiptMarkdown } from './receipt.mjs';
import { ADAPTER_VERSION } from './version.mjs';

const ZERO_HASH = '0'.repeat(64);
const CONFIGURED_HOOKS = ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];
const EVALUATION_TRIGGERS = new Set(['initial', 'post_fix_reeval', 'gate_audit', 're_examination']);
// An evaluation is terminal once its outcome is fixed: recorded, checkout-integrity excepted,
// or superseded by a moved head. Non-terminal (OPEN/CLAIMED) means a retry re-attaches; terminal
// means a fresh begin_evaluation on the same snapshot is a distinct re-examination.
export const TERMINAL_EVALUATION_STATUSES = new Set(['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION', 'STALE', 'INVALID']);

// An evaluation blocks a fresh same-snapshot begin_evaluation until it is FINISHED: dead-ended
// (STALE/INVALID), or recorded AND its evaluator child receipt sealed and retrieved — the same
// completion request_close requires. A retry arriving in the recording-to-retrieval gap therefore
// re-attaches to the unfinished evaluation instead of forking a second evaluator pass.
export function isEvaluationFinished(evaluation) {
  if (evaluation.status === 'STALE' || evaluation.status === 'INVALID') return true;
  if (!TERMINAL_EVALUATION_STATUSES.has(evaluation.status)) return false;
  return Boolean(evaluation.child_receipt_id && evaluation.child_receipt_retrieved);
}
const CAPABILITY_SHAPE = /^lyhna_(session|child)_[a-f0-9]{32,}$/;

function root() {
  const value = dataRoot();
  mkdirSync(value, { recursive: true });
  return value;
}

function masterKey() {
  const path = join(root(), 'master.key');
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return readFileSync(path);
}

function deriveCapability(kind, ...parts) {
  return `lyhna_${kind}_${createHmac('sha256', masterKey()).update(parts.join('\0')).digest('hex')}`;
}

function capabilityPath(capability) {
  return join(root(), 'capabilities', `${sha256(capability)}.json`);
}

function activePath(capability) {
  return join(root(), 'active', `${sha256(capability)}.json`);
}

function runDir(runId) {
  return join(root(), 'runs', runId);
}

function childReceiptPath(runId, receiptId) {
  return join(runDir(runId), 'child-receipts', receiptId, 'receipt.json');
}

function withChildReceiptPath(runId, receipt) {
  return { ...receipt, path: childReceiptPath(runId, receipt.id) };
}

function statePath(runId) {
  return join(runDir(runId), 'state.json');
}

function ledgerPath(runId) {
  return join(runDir(runId), 'events.jsonl');
}

function lockPath(runId) {
  return join(runDir(runId), '.lock');
}

function anchorPath(runId) {
  return join(runDir(runId), 'seal-anchor.json');
}

function checkpointAnchorPath(runId) {
  return join(runDir(runId), 'checkpoint-anchor.json');
}

function receiptIndexPath(receiptId) {
  return join(root(), 'receipt-index', `${sha256(receiptId)}.json`);
}

function sessionLockPath(capability) {
  return join(root(), 'session-locks', `${sha256(capability)}.lock`);
}

function sessionRunsPath(sessionHash) {
  return join(root(), 'session-runs', `${sessionHash}.json`);
}

function claimRejectedMarkerPath(capabilityRef) {
  return join(root(), 'claim-rejected', `claim-${capabilityRef.slice(0, 16)}.json`);
}

function verifyChildReceipts(state) {
  for (const receipt of Object.values(state.child_receipts || {})) {
    const path = childReceiptPath(state.id, receipt.id);
    assert(receipt.content_hash && existsSync(path), 'LOCAL_CHAIN_BROKEN');
    assert(sha256(readFileSync(path, 'utf8')) === receipt.content_hash, 'LOCAL_CHAIN_BROKEN');
  }
}

function writeCapability(capability, record) {
  atomicWriteJson(capabilityPath(capability), { ...record, capability_hash: sha256(capability) });
}

export function getCapability(capability) {
  assert(typeof capability === 'string' && capability.length > 20, 'INVALID_CAPABILITY');
  const record = readJson(capabilityPath(capability), null);
  assert(record && record.capability_hash === sha256(capability), 'UNKNOWN_CAPABILITY');
  return record;
}

export function mintSession({ sessionId, cwd = '', model = '' }) {
  assert(sessionId, 'MISSING_SESSION_ID');
  const sessionHash = sha256(String(sessionId));
  const capability = deriveCapability('session', sessionHash);
  const existing = readJson(capabilityPath(capability), null);
  if (!existing) {
    writeCapability(capability, {
      kind: 'parent',
      session_hash: sessionHash,
      cwd_ref: cwd ? reference(String(cwd)) : null,
      model: boundedText(model, 100) || null
    });
  }
  return capability;
}

export function mintChild({ sessionId, agentId, hookPayload = null, hookDeliveryKey = null }) {
  assert(sessionId, 'MISSING_SESSION_ID');
  assert(agentId, 'MISSING_AGENT_ID');
  const parentCapability = deriveCapability('session', sha256(String(sessionId)));
  const parent = getCapability(parentCapability);
  const activeRunId = activeRunFor(parentCapability);
  if (!activeRunId) return null;
  const agentHash = sha256(String(agentId));
  const capability = deriveCapability('child', parent.session_hash, activeRunId, agentHash);
  withLock(lockPath(activeRunId), () => {
    const current = loadState(activeRunId);
    assert(!current.sealed, 'RUN_SEALED');
    if (!readJson(capabilityPath(capability), null)) {
      writeCapability(capability, {
        kind: 'child',
        agent_hash: agentHash,
        parent_capability_hash: sha256(parentCapability),
        parent_run_id: activeRunId
      });
    }
    let startEvent = null;
    if (hookPayload) {
      startEvent = appendEventUnlocked(activeRunId, current, {
        type: 'hook_subagentstart',
        origin: 'runtime_hook',
        payload: hookPayload,
        idempotencyKey: hookDeliveryKey || `hook:SubagentStart:${sha256(canonicalJson(hookPayload))}`
      });
    }
    current.children ||= {};
    if (!current.children[agentHash]) {
      const childId = `child_agent_${sha256(`${activeRunId}\0${agentHash}`).slice(0, 24)}`;
      const childStartedEvent = appendEventUnlocked(activeRunId, current, {
        type: 'child_started',
        origin: 'runtime_hook',
        payload: { child_id: childId, role: 'delegated_agent', status: 'STARTED' },
        idempotencyKey: `child-start:${childId}`
      });
      current.children[agentHash] = {
        id: childId,
        role: 'delegated_agent',
        status: 'STARTED',
        start_event_ref: startEvent?.event_hash || childStartedEvent.event_hash,
        stop_event_ref: null,
        receipt_id: null
      };
    }
    saveState(current);
  });
  return capability;
}

export function findParentCapabilityBySession(sessionId) {
  if (!sessionId) return null;
  const capability = deriveCapability('session', sha256(String(sessionId)));
  return readJson(capabilityPath(capability), null) ? capability : null;
}

export function activeRunFor(capability, { includeSealed = false } = {}) {
  const record = readJson(activePath(capability), null);
  if (!record?.run_id) return null;
  const state = readJson(statePath(record.run_id), null);
  if (!includeSealed && state?.sealed && existsSync(anchorPath(record.run_id))) return null;
  return record.run_id;
}

function loadState(runId) {
  const state = readJson(statePath(runId), null);
  assert(state, 'RUN_NOT_FOUND');
  return state;
}

function stripLegacyChildReceiptPaths(state) {
  for (const receipt of Object.values(state.child_receipts || {})) delete receipt.path;
}

function saveState(state) {
  if (!state.sealed) stripLegacyChildReceiptPaths(state);
  atomicWriteJson(statePath(state.id), state);
}

function parseLedger(runId) {
  const path = ledgerPath(runId);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const events = [];
  let previous = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      throw Object.assign(new Error('LOCAL_CHAIN_BROKEN: invalid JSON'), { code: 'LOCAL_CHAIN_BROKEN' });
    }
    const claimed = event.event_hash;
    const withoutHash = { ...event };
    delete withoutHash.event_hash;
    const expected = sha256(canonicalJson(withoutHash));
    assert(event.seq === index + 1 && event.prev_hash === previous && claimed === expected, 'LOCAL_CHAIN_BROKEN');
    previous = claimed;
    events.push(event);
  }
  return { events, tip: previous };
}

export function readLedger(runId, { allowOpen = true, recoverOpen = true } = {}) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assert(allowOpen || state.sealed, 'RUN_NOT_SEALED');
    const { events, tip } = parseLedger(runId);
    if (!state.sealed && recoverOpen && events.length > state.ledger_count) {
      const prefixTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1]?.event_hash;
      assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
      state.ledger_count = events.length;
      state.ledger_tip = tip;
      saveState(state);
    }
    assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
    if (state.sealed) {
      verifyChildReceipts(state);
      const anchor = readJson(anchorPath(runId), null);
      assert(
        anchor
        && anchor.run_id === runId
        && anchor.final_seq === events.length
        && anchor.final_hash === tip
        && anchor.state_hash === sha256(canonicalJson(state)),
        'LOCAL_CHAIN_BROKEN'
      );
    }
    return events;
  });
}

// The DURABLE seal signal is the run_sealed EVENT in the ledger, not the state.sealed flag: a crash
// after run_sealed is appended but before state and the seal anchor are written leaves the ledger
// sealed while state.sealed is still false. Adopt that terminal event into state (so repairSeal's
// consistency holds and any reader routes to the sealed path), failing closed if anything follows the
// first run_sealed — that would be post-seal corruption to surface, not fold into the receipt. Shared
// by checkpointOrSeal and verifyRun so a sealed ledger is never misclassified as open. Returns the
// parsed ledger so the caller can reuse it.
function adoptTerminalLedgerSeal(runId, state) {
  const parsed = parseLedger(runId);
  if (!state.sealed) {
    const sealedIndex = parsed.events.findIndex((event) => event.type === 'run_sealed');
    if (sealedIndex !== -1) {
      assert(sealedIndex === parsed.events.length - 1, 'LOCAL_CHAIN_BROKEN');
      stripLegacyChildReceiptPaths(state);
      state.sealed = true;
      state.ledger_count = parsed.events.length;
      state.ledger_tip = parsed.tip;
      saveState(state);
    }
  }
  return parsed;
}

function repairSeal(runId) {
  const state = loadState(runId);
  assert(state.sealed, 'RUN_NOT_SEALED');
  const { events, tip } = parseLedger(runId);
  assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  // A sealed run's FIRST run_sealed must be its terminal event: exactly one seal, at the end. Anything
  // after it — including a second run_sealed with a post-seal event between — is corruption to fail on,
  // not fold into the receipt (checking only the last event would miss an earlier seal + later write).
  assert(events.findIndex((event) => event.type === 'run_sealed') === events.length - 1, 'LOCAL_CHAIN_BROKEN');
  verifyChildReceipts(state);
  const stateHash = sha256(canonicalJson(state));
  const jsonPath = join(runDir(runId), 'receipt.json');
  const markdownPath = join(runDir(runId), 'RECEIPT.md');
  const anchor = readJson(anchorPath(runId), null);

  // The renderer gate reads the hash-chained run_sealed event, never the mutable anchor:
  // deleting or editing the anchor's informational receipt_renderer field must not be able
  // to select the weaker legacy path for a run the current renderer sealed.
  const sealedRenderer = events.find((event) => event.type === 'run_sealed')?.payload?.receipt_renderer ?? null;

  if (anchor) {
    // Ledger and state hash checks always apply — tamper evidence, renderer-independent.
    assert(
      anchor.run_id === runId
      && anchor.final_seq === events.length
      && anchor.final_hash === tip
      && anchor.state_hash === stateHash,
      'LOCAL_CHAIN_BROKEN'
    );
    if (sealedRenderer === ADAPTER_VERSION) {
      // Current renderer: the on-disk receipt must reproduce exactly what we render now.
      const receiptJson = renderReceiptJson(state, events);
      const receiptMarkdown = renderReceiptMarkdown(state, events);
      assert(anchor.receipt_json_hash === sha256(receiptJson), 'LOCAL_CHAIN_BROKEN');
      assert(anchor.receipt_markdown_hash === sha256(receiptMarkdown), 'LOCAL_CHAIN_BROKEN');
      if (existsSync(jsonPath)) assert(sha256(readFileSync(jsonPath, 'utf8')) === anchor.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      else atomicWriteText(jsonPath, receiptJson);
      if (existsSync(markdownPath)) assert(sha256(readFileSync(markdownPath, 'utf8')) === anchor.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
      else atomicWriteText(markdownPath, receiptMarkdown);
    } else {
      // Backward read-compat: the ledger's run_sealed event names no current-version renderer,
      // so this run was sealed by another renderer whose bytes we cannot reproduce. We do NOT
      // re-render or rewrite the receipt files; we verify the on-disk files still hash to the
      // anchor (tamper evidence preserved) and trust the anchor the seal committed to.
      assert(existsSync(jsonPath) && sha256(readFileSync(jsonPath, 'utf8')) === anchor.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(existsSync(markdownPath) && sha256(readFileSync(markdownPath, 'utf8')) === anchor.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
    }
    dropCheckpointAnchor(runId);
    return { status: 'ALREADY_SEALED', run_id: runId, receipt_path: markdownPath };
  }

  // No anchor on disk (interrupted seal): re-render with the current renderer and write the anchor.
  const receiptJson = renderReceiptJson(state, events);
  const receiptMarkdown = renderReceiptMarkdown(state, events);
  const expected = {
    run_id: runId,
    final_seq: events.length,
    final_hash: tip,
    state_hash: stateHash,
    receipt_json_hash: sha256(receiptJson),
    receipt_markdown_hash: sha256(receiptMarkdown),
    receipt_renderer: ADAPTER_VERSION
  };
  // CZ-14: pre-seal Stops leave checkpoint receipt files on disk, so an interrupted seal (crash
  // after the sealed state was saved, before the sealed receipt files were written) presents here
  // with receipt bytes that mismatch the sealed render. Those bytes are recognized by the
  // hash-chained checkpoint_anchor event that committed them and overwritten with the sealed
  // render — an interrupted seal recovers; it is not tamper. Any committed checkpoint anchor's slot
  // is accepted, not only the last: if that final checkpoint write was itself torn, the on-disk
  // bytes legitimately match an EARLIER anchor (the same newest-first tolerance verifyOpenPacket
  // applies). Bytes matching neither the sealed render nor any ledger-committed checkpoint fail closed.
  const checkpointJsonHashes = new Set();
  const checkpointMarkdownHashes = new Set();
  for (const event of events) {
    if (event.type !== 'checkpoint_anchor') continue;
    checkpointJsonHashes.add(event.payload?.receipt_json_hash);
    checkpointMarkdownHashes.add(event.payload?.receipt_markdown_hash);
  }
  const staleCheckpointFile = (path, sealedHash, committedHashes) => {
    if (!existsSync(path)) return true;
    const hash = sha256(readFileSync(path, 'utf8'));
    if (hash === sealedHash) return false;
    assert(committedHashes.has(hash), 'LOCAL_CHAIN_BROKEN');
    return true;
  };
  if (staleCheckpointFile(jsonPath, expected.receipt_json_hash, checkpointJsonHashes)) atomicWriteText(jsonPath, receiptJson);
  if (staleCheckpointFile(markdownPath, expected.receipt_markdown_hash, checkpointMarkdownHashes)) atomicWriteText(markdownPath, receiptMarkdown);
  atomicWriteJson(anchorPath(runId), expected);
  dropCheckpointAnchor(runId);
  return { status: 'ALREADY_SEALED', run_id: runId, receipt_path: markdownPath };
}

// A sealed packet carries exactly one anchor — the seal anchor. Cleanup of a leftover checkpoint
// anchor is best-effort: a copied packet may sit on read-only media, and cleanup must never turn
// verification into a raw filesystem error; a tolerated leftover is ignored by the sealed path.
function dropCheckpointAnchor(runId) {
  try {
    rmSync(checkpointAnchorPath(runId), { force: true });
  } catch {
    /* tolerated */
  }
}

function appendEventUnlocked(runId, state, { type, origin, payload, idempotencyKey }) {
  assert(ORIGINS.has(origin), 'INVALID_ORIGIN');
  assert(!state.sealed, 'RUN_SEALED');
  const { events, tip } = parseLedger(runId);
  if (events.length > state.ledger_count) {
    const prefixTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1]?.event_hash;
    assert(prefixTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
    state.ledger_count = events.length;
    state.ledger_tip = tip;
  }
  assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  const key = idempotencyKey || sha256(canonicalJson({ origin, payload, type }));
  const contentHash = sha256(canonicalJson({ origin, payload, type }));
  const duplicate = events.find((event) => event.idempotency_key === key);
  if (duplicate) {
    assert(contentHash === duplicate.content_hash, 'IDEMPOTENCY_CONFLICT');
    return duplicate;
  }
  const event = {
    schema: 'lyhna.codex.event.v0',
    seq: events.length + 1,
    prev_hash: events.at(-1)?.event_hash || ZERO_HASH,
    idempotency_key: key,
    content_hash: contentHash,
    type,
    origin,
    payload
  };
  event.event_hash = sha256(canonicalJson(event));
  mkdirSync(runDir(runId), { recursive: true });
  appendFileSync(ledgerPath(runId), `${canonicalJson(event)}\n`, { encoding: 'utf8', flush: true });
  state.ledger_count = event.seq;
  state.ledger_tip = event.event_hash;
  return event;
}

export function appendEvent(runId, input) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    const event = appendEventUnlocked(runId, state, input);
    saveState(state);
    return event;
  });
}

function requireParent(capability, { mutable = true } = {}) {
  const record = getCapability(capability);
  assert(record.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  const runId = activeRunFor(capability, { includeSealed: !mutable });
  assert(runId, 'NO_ACTIVE_RUN');
  const state = loadState(runId);
  if (mutable) assert(!state.sealed, 'RUN_SEALED');
  assert(state.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
  return { record, runId, state };
}

function requireChild(capability) {
  const record = getCapability(capability);
  assert(record.kind === 'child', 'CHILD_CAPABILITY_REQUIRED');
  const state = loadState(record.parent_run_id);
  assert(!state.sealed, 'RUN_SEALED');
  return { record, runId: record.parent_run_id, state };
}

export function beginRun(capability, { mode, objective = '' }) {
  const parent = getCapability(capability);
  assert(parent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  assert(mode === 'full' || mode === 'pr_only', 'INVALID_MODE');
  return withLock(sessionLockPath(capability), () => {
    const pendingPath = join(root(), 'pending', `${parent.session_hash}.json`);
    const pending = readJson(pendingPath, null);
    const current = activeRunFor(capability, { includeSealed: true });
    if (current) {
      const state = loadState(current);
      if (!state.sealed) {
        if (pending) rmSync(pendingPath, { force: true });
        return state;
      }
      if (!existsSync(anchorPath(current))) repairSeal(current);
    }
    // CZ-12: observe (never judge) any prior run in this session left OPEN with no close request.
    const sessionIndex = readJson(sessionRunsPath(parent.session_hash), { run_ids: [] });
    const openPredecessors = [];
    for (const priorId of sessionIndex.run_ids || []) {
      const priorState = readJson(statePath(priorId), null);
      if (priorState && !priorState.sealed && !priorState.close_requested) {
        openPredecessors.push({ run_id: priorId, last_event_seq: priorState.ledger_count });
      }
    }
    openPredecessors.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
    const runId = `run_${randomUUID()}`;
    const state = {
      schema: 'lyhna.codex.run.v0',
      id: runId,
      mode,
      sealed: false,
      parent_capability_hash: sha256(capability),
      objective: pending?.summary || promptSynopsis(objective),
      objective_ref: pending?.ref || sha256(String(objective || '')),
      objective_origin: pending ? 'runtime_hook' : 'agent_reported',
      configured_hooks: CONFIGURED_HOOKS,
      ledger_count: 0,
      ledger_tip: ZERO_HASH,
      close_requested: null,
      open_predecessors: openPredecessors,
      pr_snapshots: {},
      evaluations: {},
      children: {},
      child_receipts: {}
    };
    mkdirSync(runDir(runId), { recursive: true });
    const runBegunPayload = { mode, objective_origin: state.objective_origin };
    if (pending) runBegunPayload.invocation = { matched_form: pending.matched_form, mention_offset: pending.mention_offset };
    if (openPredecessors.length) runBegunPayload.open_predecessors = openPredecessors;
    withLock(lockPath(runId), () => {
      appendEventUnlocked(runId, state, {
        type: 'run_begun',
        origin: 'mcp_routed',
        payload: runBegunPayload,
        idempotencyKey: `begin:${runId}`
      });
      saveState(state);
    });
    atomicWriteJson(activePath(capability), { run_id: runId });
    const nextRunIds = [...(sessionIndex.run_ids || [])];
    if (!nextRunIds.includes(runId)) nextRunIds.push(runId);
    atomicWriteJson(sessionRunsPath(parent.session_hash), { run_ids: nextRunIds });
    if (pending) rmSync(pendingPath, { force: true });
    return state;
  });
}

const INVOCATION_NON_BOUNDARY_BEFORE = /[\p{L}\p{M}\p{N}_@]/u;
const INVOCATION_STRUCTURED = /^\[@?lyhna[^\]]*\]\(plugin:\/\/lyhna-codex-adapter(?=[^\p{L}\p{M}\p{N}_-])[^)]*\)/iu;
const INVOCATION_URI = /plugin:\/\/lyhna-codex-adapter(?=$|[^\p{L}\p{M}\p{N}_-])/giu;
const INVOCATION_LITERAL_LONG = /^@lyhna-codex-adapter(?:@[a-z0-9-]+)?(?=$|[^\p{L}\p{M}\p{N}_-])/iu;
const INVOCATION_LITERAL_SHORT = /^@lyhna(?=$|[^\p{L}\p{M}\p{N}_-])/iu;
const INVOCATION_LITERAL_DOLLAR = /^\$lyhna(?=$|[^\p{L}\p{M}\p{N}_-])/iu;

function detectInvocation(promptText) {
  for (let index = 0; index < promptText.length; index += 1) {
    const rest = promptText.slice(index);
    if (INVOCATION_STRUCTURED.test(rest)) return { matched_form: 'structured', mention_offset: index };
    if (index !== 0 && INVOCATION_NON_BOUNDARY_BEFORE.test(promptText[index - 1])) continue;
    if (INVOCATION_LITERAL_LONG.test(rest)) return { matched_form: 'literal_long', mention_offset: index };
    if (INVOCATION_LITERAL_SHORT.test(rest)) return { matched_form: 'literal_short', mention_offset: index };
    if (INVOCATION_LITERAL_DOLLAR.test(rest)) return { matched_form: 'literal_dollar', mention_offset: index };
  }
  for (const uriMatch of promptText.matchAll(INVOCATION_URI)) {
    if (uriMatch.index === 0 || !INVOCATION_NON_BOUNDARY_BEFORE.test(promptText[uriMatch.index - 1])) {
      return { matched_form: 'structured', mention_offset: uriMatch.index };
    }
  }
  return null;
}

function maskContextCharacter(ch) {
  if (/\s/.test(ch)) return ' ';
  if (/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(ch)) return ch;
  if (/\p{Nd}/u.test(ch)) return '9';
  if (/\p{Lu}/u.test(ch)) return 'A';
  if (/[\p{L}\p{M}\p{N}]/u.test(ch)) return 'a';
  return '?';
}

function maskedMentionContexts(promptText) {
  const contexts = [];
  const pattern = /lyhna/gi;
  let match;
  while ((match = pattern.exec(promptText)) && contexts.length < 8) {
    const start = Math.max(0, match.index - 16);
    const end = Math.min(promptText.length, match.index + match[0].length + 16);
    contexts.push(Array.from(promptText.slice(start, end), maskContextCharacter).join(''));
  }
  return contexts;
}

function coercePromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((part) => {
      if (typeof part === 'string') return part;
      return part === null || part === undefined ? '' : canonicalJson(part);
    }).join('\n');
  }
  if (prompt && typeof prompt === 'object') return canonicalJson(prompt);
  return '';
}

const INVOCATION_MISS_LIMIT = 32;

function recordInvocationMiss(promptText) {
  if (!/lyhna/i.test(promptText)) return;
  const missDir = join(root(), 'pending-miss');
  let existing = [];
  try { existing = readdirSync(missDir); } catch { existing = []; }
  const digest = sha256(promptText);
  if (existing.length >= INVOCATION_MISS_LIMIT && !existing.includes(`miss-${digest.slice(0, 16)}.json`)) return;
  const lower = promptText.toLowerCase();
  atomicWriteJson(join(missDir, `miss-${digest.slice(0, 16)}.json`), {
    ref: digest,
    prompt_bytes: Buffer.byteLength(promptText),
    contains_at_sigil: lower.includes('@lyhna'),
    contains_dollar_sigil: lower.includes('$lyhna'),
    contains_plugin_uri: lower.includes('plugin://lyhna-codex-adapter'),
    mention_contexts: maskedMentionContexts(promptText)
  });
}

export function rememberInvocation({ sessionId, prompt }) {
  const promptText = coercePromptText(prompt);
  const detected = detectInvocation(promptText);
  if (!detected) {
    recordInvocationMiss(promptText);
    return false;
  }
  if (!sessionId) return false;
  const sessionHash = sha256(String(sessionId));
  atomicWriteJson(join(root(), 'pending', `${sessionHash}.json`), {
    summary: promptSynopsis(promptText),
    ref: sha256(promptText),
    matched_form: detected.matched_form,
    mention_offset: detected.mention_offset,
    prompt_bytes: Buffer.byteLength(promptText)
  });
  return true;
}

export function recordClaim(capability, statement, evidenceRefs = []) {
  const { runId } = requireParent(capability);
  const payload = sanitizeClaim(statement, evidenceRefs);
  return appendEvent(runId, {
    type: 'builder_claim',
    origin: 'agent_reported',
    payload,
    idempotencyKey: `claim:${sha256(canonicalJson(payload))}`
  });
}

export function recordHookForParent(capability, payload, idempotencyKey) {
  const runId = activeRunFor(capability);
  if (!runId) return null;
  if (loadState(runId).sealed) return null;
  return appendEvent(runId, {
    type: `hook_${String(payload.event || 'unknown').toLowerCase()}`,
    origin: 'runtime_hook',
    payload,
    idempotencyKey
  });
}

// Occurrence numbering for same-base snapshots. A force-push away from head H and back to H
// produces the same deterministic base id; each distinct observation gets its own record so a
// STALE observation is never overwritten (which would resurrect it as CONSISTENT and erase the
// earlier receipt, violating SPEC exact-head staleness). Base is occurrence 1; re-observations
// after divergence are <base>-o2, -o3, ... mirroring beginEvaluation's occurrence suffix.
function snapshotOccurrenceIndex(base, id) {
  if (id === base) return 1;
  const match = /^-o(\d+)$/.exec(id.slice(base.length));
  return match ? Number(match[1]) : 1;
}

export function addPrSnapshot(capability, snapshot) {
  const { runId } = requireParent(capability);
  const base = snapshot.id || `pr_${sha256(canonicalJson({ runId, snapshot })).slice(0, 24)}`;
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assert(!state.sealed && state.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
    // Prior observations recorded under this deterministic base id (the same id recurs when the head
    // is force-pushed away and back). The latest one is the observation a re-snapshot is compared to.
    const priorOccurrences = Object.values(state.pr_snapshots)
      .filter((item) => item.id === base || item.id.startsWith(`${base}-o`));
    const latest = priorOccurrences.length
      ? priorOccurrences.reduce((a, b) => (snapshotOccurrenceIndex(base, b.id) > snapshotOccurrenceIndex(base, a.id) ? b : a))
      : null;
    // Divergence signal: the latest observation at this id went STALE, or an intervening pr_refreshed
    // observed a head different from that observation's head after its own snapshot event. Either way
    // the head has since moved, so a re-snapshot is a NEW observation, not an overwrite of the old one.
    let diverged = false;
    if (latest) {
      if (latest.status === 'STALE') {
        diverged = true;
      } else {
        const { events } = parseLedger(runId);
        const latestSnapshotSeq = events.find((event) => event.type === 'pr_snapshot' && event.payload.id === latest.id)?.seq ?? 0;
        diverged = events.some((event) => event.type === 'pr_refreshed'
          && event.payload.snapshot_id === latest.id
          && event.seq > latestSnapshotSeq
          && event.payload.observed_head !== latest.head_after);
      }
    }
    // No prior observation: the base id. Diverged: a fresh occurrence-suffixed id and its own ledger
    // event (the id in the idempotency key carries the occurrence, so it never dedupes against the
    // first observation). Plain retry (prior observation, no divergence): the same id — an idempotent
    // re-read that dedupes its event and must NOT resurrect the existing record's status or drop fields.
    const id = !latest ? base : diverged ? `${base}-o${priorOccurrences.length + 1}` : latest.id;
    const normalized = { ...snapshot, id };
    appendEventUnlocked(runId, state, {
      type: 'pr_snapshot',
      origin: 'github_observed',
      payload: {
        id,
        repository: normalized.repository,
        pr_number: normalized.pr_number,
        head_before: normalized.head_before,
        head_after: normalized.head_after,
        status: normalized.status,
        counts: {
          files: normalized.files?.length || 0,
          checks: normalized.checks?.length || 0,
          reviews: normalized.reviews?.length || 0,
          review_comments: normalized.review_comments?.length || 0,
          issue_comments: normalized.issue_comments?.length || 0
        },
        failures: normalized.failures || []
      },
      idempotencyKey: `snapshot:${id}`
    });
    // Plain retry keeps the existing record untouched (no status resurrection, no lost refresh state);
    // a new (base or occurrence) observation is stored as itself.
    if (latest && !diverged) state.pr_snapshots[id] ||= normalized;
    else state.pr_snapshots[id] = normalized;
    saveState(state);
    return state.pr_snapshots[id];
  });
}

export function beginEvaluation(capability, snapshotId, checkout = {}, trigger = 'unspecified') {
  const { runId } = requireParent(capability);
  const normalizedTrigger = EVALUATION_TRIGGERS.has(trigger) ? trigger : 'unspecified';
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    assert(!current.sealed && current.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
    const snapshot = current.pr_snapshots[snapshotId];
    assert(snapshot, 'SNAPSHOT_NOT_FOUND');
    assert(snapshot.status === 'CONSISTENT', 'INCONSISTENT_SNAPSHOT');
    assert(checkout.path && checkout.head === snapshot.head_after && checkout.clean === true && checkout.detached === true, 'EVALUATOR_CHECKOUT_REQUIRED');
    const snapshotEvaluations = Object.values(current.evaluations).filter((item) => item.snapshot_id === snapshotId);
    // Retry idempotency: while an evaluation for this snapshot is unfinished — non-terminal
    // (OPEN/CLAIMED), or recorded but its child receipt not yet sealed and retrieved —
    // begin_evaluation returns it unchanged so a repeated request keeps the first trigger and status.
    const active = snapshotEvaluations.find((item) => !isEvaluationFinished(item));
    if (active) return active;
    // Every prior evaluation for this snapshot finished. A fresh begin_evaluation
    // — e.g. a re-examination of an unchanged head that snapshotted to the same deterministic id —
    // creates a NEW evaluation with a deterministic occurrence-suffixed id (derived from the count of
    // prior evaluations, no clock or randomness) so same-head evaluations stay distinct, each carrying
    // its own trigger.
    const base = `eval_${sha256(`${runId}:${snapshotId}`).slice(0, 24)}`;
    const id = snapshotEvaluations.length === 0 ? base : `${base}-r${snapshotEvaluations.length + 1}`;
    appendEventUnlocked(runId, current, {
      type: 'evaluation_requested',
      origin: 'mcp_routed',
      payload: { evaluation_request_id: id, snapshot_id: snapshotId, expected_head: snapshot.head_after, trigger: normalizedTrigger },
      idempotencyKey: `evaluation-request:${id}`
    });
    current.evaluations[id] = {
      id,
      snapshot_id: snapshotId,
      expected_head: snapshot.head_after,
      status: 'OPEN',
      trigger: normalizedTrigger,
      child_capability_hash: null,
      child_agent_hash: null,
      checkout_path_ref: reference(checkout.path),
      checkout_head_before: checkout.head,
      checkout_clean_before: checkout.clean,
      checkout_detached_before: checkout.detached,
      findings: []
    };
    saveState(current);
    return current.evaluations[id];
  });
}

export function claimEvaluation(childCapability, evaluationId) {
  const { record, runId } = requireChild(childCapability);
  const childHash = sha256(childCapability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    assert(!current.sealed, 'RUN_SEALED');
    assert(record.parent_capability_hash === current.parent_capability_hash, 'EVALUATOR_PARENT_MISMATCH');
    assert(childHash !== current.parent_capability_hash, 'SELF_REVIEW_REJECTED');
    const item = current.evaluations[evaluationId];
    assert(item, 'EVALUATION_NOT_FOUND');
    assert(!item.child_capability_hash, 'EVALUATION_ALREADY_CLAIMED');
    assert(item.status === 'OPEN', 'EVALUATION_NOT_CLAIMABLE');
    appendEventUnlocked(runId, current, {
      type: 'evaluation_claimed',
      origin: 'mcp_routed',
      payload: { evaluation_request_id: evaluationId, child_agent_hash: record.agent_hash },
      idempotencyKey: `evaluation-claim:${evaluationId}:${record.agent_hash}`
    });
    item.child_capability_hash = childHash;
    item.child_agent_hash = record.agent_hash;
    item.status = 'CLAIMED';
    current.children ||= {};
    if (current.children[record.agent_hash]) current.children[record.agent_hash].role = 'evaluator';
    saveState(current);
    return item;
  });
}

export function recordEvaluation(childCapability, evaluationId, finding, evidenceRefs = [], checkout = {}) {
  const { record, runId } = requireChild(childCapability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    const item = current.evaluations[evaluationId];
    assert(item, 'EVALUATION_NOT_FOUND');
    assert(item.child_capability_hash === sha256(childCapability), 'EVALUATOR_NOT_BOUND');
    assert(item.child_agent_hash === record.agent_hash, 'EVALUATOR_NOT_BOUND');
    assert(!item.child_receipt_id, 'EVALUATION_RECEIPT_SEALED');
    assert(['CLAIMED', 'RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(item.status), 'EVALUATION_NOT_RECORDABLE');
    const priorIntegrityException = item.status === 'CHECKOUT_INTEGRITY_EXCEPTION';
    const cleanBefore = checkout.clean_before ?? item.checkout_clean_before;
    const cleanAfter = checkout.clean_after ?? null;
    const headBefore = checkout.head_before ?? item.checkout_head_before;
    const headAfter = checkout.head_after ?? null;
    const detachedBefore = checkout.detached_before ?? item.checkout_detached_before;
    const detachedAfter = checkout.detached_after ?? null;
    const integrityOk = headBefore === item.expected_head && headAfter === item.expected_head && cleanBefore === true && cleanAfter === true && detachedBefore === true && detachedAfter === true;
    const payload = {
      ...sanitizeClaim(finding, evidenceRefs),
      evaluation_request_id: evaluationId,
      expected_head: item.expected_head,
      checkout_head_before: headBefore,
      checkout_head_after: headAfter,
      checkout_clean_before: cleanBefore,
      checkout_clean_after: cleanAfter,
      checkout_detached_before: detachedBefore,
      checkout_detached_after: detachedAfter,
      checkout_integrity: integrityOk ? 'CONSISTENT_CLEAN' : 'CHECKOUT_INTEGRITY_EXCEPTION'
    };
    const findingAlreadyRecorded = item.findings.some((existing) => sha256(canonicalJson(existing)) === sha256(canonicalJson(payload)));
    appendEventUnlocked(runId, current, {
      type: 'evaluation_finding',
      origin: 'evaluator_reported',
      payload,
      idempotencyKey: `evaluation-finding:${evaluationId}:${sha256(canonicalJson(payload))}`
    });
    if (!findingAlreadyRecorded) item.findings.push(payload);
    item.checkout_head_before = headBefore;
    item.checkout_head_after = headAfter;
    item.checkout_clean_before = cleanBefore;
    item.checkout_clean_after = cleanAfter;
    item.checkout_detached_before = detachedBefore;
    item.checkout_detached_after = detachedAfter;
    item.status = integrityOk && !priorIntegrityException ? 'RECORDED' : 'CHECKOUT_INTEGRITY_EXCEPTION';
    saveState(current);
    return item;
  });
}

export function markSnapshotRefreshed(capability, snapshotId, currentHead) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    const snapshot = current.pr_snapshots[snapshotId];
    assert(snapshot, 'SNAPSHOT_NOT_FOUND');
    const stale = currentHead !== snapshot.head_after;
    // A refresh after new evaluation activity is a distinct observation — the CURRENT label
    // depends on a pr_refreshed event later in the ledger than the final evaluation event
    // (requested OR finding), so the idempotency key carries both the evaluation count and the
    // recorded-finding count at refresh time. A refresh between begin_evaluation and
    // record_evaluation therefore cannot swallow the required post-finding refresh, while plain
    // retries (no intervening evaluation activity) still dedupe to one recorded observation.
    const snapshotEvaluations = Object.values(current.evaluations).filter((item) => item.snapshot_id === snapshotId);
    const evaluationCount = snapshotEvaluations.length;
    const findingCount = snapshotEvaluations.reduce((total, item) => total + (item.findings?.length || 0), 0);
    appendEventUnlocked(runId, current, {
      type: 'pr_refreshed',
      origin: 'github_observed',
      payload: { snapshot_id: snapshotId, observed_head: currentHead, status: stale ? 'STALE' : 'CURRENT_AT_REFRESH' },
      idempotencyKey: `refresh:${snapshotId}:${currentHead}:e${evaluationCount}f${findingCount}`
    });
    current.pr_snapshots[snapshotId].current_head = currentHead;
    current.pr_snapshots[snapshotId].status = stale ? 'STALE' : current.pr_snapshots[snapshotId].status;
    if (stale) {
      for (const evaluation of Object.values(current.evaluations)) {
        if (evaluation.snapshot_id === snapshotId) evaluation.status = 'STALE';
      }
    }
    saveState(current);
    return { stale, current_head: currentHead };
  });
}

export function requestClose(capability, reason) {
  const { runId } = requireParent(capability);
  const payload = { reason: structuralSummary(reason, 'Close reason'), reason_ref: sha256(String(reason || '')) };
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    appendEventUnlocked(runId, state, { type: 'close_requested', origin: 'mcp_routed', payload, idempotencyKey: `close:${sha256(canonicalJson(payload))}` });
    state.close_requested = payload;
    saveState(state);
    return { run_id: runId, close_requested: true };
  });
}

export function sealChildByAgent({ sessionId, agentId, hookPayload = null, hookDeliveryKey = null }) {
  const parentCapability = findParentCapabilityBySession(sessionId);
  if (!parentCapability) return null;
  const runId = activeRunFor(parentCapability);
  if (!runId) return null;
  const agentHash = sha256(String(agentId || ''));
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    let stopEvent = null;
    if (hookPayload) {
      stopEvent = appendEventUnlocked(runId, current, {
        type: 'hook_subagentstop',
        origin: 'runtime_hook',
        payload: hookPayload,
        idempotencyKey: hookDeliveryKey || `hook:SubagentStop:${sha256(canonicalJson(hookPayload))}`
      });
    }
    current.children ||= {};
    const child = current.children[agentHash];
    if (child) {
      const childStoppedEvent = appendEventUnlocked(runId, current, {
        type: 'child_stop_observed',
        origin: 'runtime_hook',
        payload: { child_id: child.id, role: child.role, status: 'STOP_OBSERVED' },
        idempotencyKey: `child-stop:${child.id}`
      });
      child.status = 'STOP_OBSERVED';
      child.stop_event_ref = stopEvent?.event_hash || childStoppedEvent.event_hash;
    }
    const recordable = Object.values(current.evaluations).filter((item) => (
      item.child_agent_hash === agentHash
      && ['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(item.status)
    ));
    const evaluation = recordable.find((item) => !item.child_receipt_id) || recordable.find((item) => item.child_receipt_id);
    if (evaluation?.child_receipt_id) {
      atomicWriteJson(receiptIndexPath(evaluation.child_receipt_id), { receipt_id: evaluation.child_receipt_id, run_id: runId });
      saveState(current);
      return withChildReceiptPath(runId, current.child_receipts[evaluation.child_receipt_id]);
    }

    const assignedEvaluation = Object.values(current.evaluations).find((item) => item.child_agent_hash === agentHash);
    if (!evaluation && !child) {
      saveState(current);
      return null;
    }

    const receiptId = evaluation ? `child_${evaluation.id}` : child.id;
    if (!evaluation && child.receipt_id) {
      atomicWriteJson(receiptIndexPath(child.receipt_id), { receipt_id: child.receipt_id, run_id: runId });
      saveState(current);
      return withChildReceiptPath(runId, current.child_receipts[child.receipt_id]);
    }
    const role = evaluation || assignedEvaluation ? 'evaluator' : 'delegated_agent';
    const status = evaluation ? evaluation.status : 'STOP_OBSERVED';
    const receipt = evaluation ? {
      schema: 'lyhna.codex.child-receipt.v0',
      id: receiptId,
      role,
      evaluation_id: evaluation.id,
      expected_head: evaluation.expected_head,
      status,
      findings: evaluation.findings,
      ...(child ? {
        lifecycle: {
          start: {
            origin: 'runtime_hook',
            support: 'lifecycle_observed_not_execution',
            event_ref: child.start_event_ref
          },
          stop: {
            origin: 'runtime_hook',
            support: 'lifecycle_observed_not_execution',
            event_ref: child.stop_event_ref
          }
        }
      } : {})
    } : {
      schema: 'lyhna.codex.child-receipt.v0',
      id: receiptId,
      role,
      status,
      lifecycle: {
        start: {
          origin: 'runtime_hook',
          support: 'lifecycle_observed_not_execution',
          event_ref: child.start_event_ref
        },
        stop: {
          origin: 'runtime_hook',
          support: 'lifecycle_observed_not_execution',
          event_ref: child.stop_event_ref
        }
      },
      limitations: [
        'This child receipt records lifecycle coverage only; it does not claim what the delegated agent inspected, changed, or completed.'
      ],
      ...(assignedEvaluation ? {
        evaluation_id: assignedEvaluation.id,
        evaluation_status: assignedEvaluation.status
      } : {})
    };
    const path = childReceiptPath(runId, receiptId);
    const content = canonicalJson(receipt, true);
    const contentHash = sha256(content);
    atomicWriteText(path, content);
    appendEventUnlocked(runId, current, {
      type: 'child_receipt_sealed',
      origin: 'runtime_hook',
      payload: { receipt_id: receiptId, role, status, content_ref: contentHash },
      idempotencyKey: `child-seal:${receiptId}`
    });
    current.child_receipts[receiptId] = { id: receiptId, role, status, content_hash: contentHash, retrieved: false };
    if (evaluation) evaluation.child_receipt_id = receiptId;
    if (child) {
      child.role = role;
      child.status = 'STOP_OBSERVED';
      child.receipt_id = receiptId;
    }
    atomicWriteJson(receiptIndexPath(receiptId), { receipt_id: receiptId, run_id: runId });
    saveState(current);
    return withChildReceiptPath(runId, current.child_receipts[receiptId]);
  });
}

export function listChildReceipts(capability) {
  const { state } = requireParent(capability, { mutable: false });
  return Object.values(state.child_receipts).map(({ path: _path, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id));
}

export function readSealedReceipt(capability, receiptId) {
  const parent = getCapability(capability);
  assert(parent.kind === 'parent', 'PARENT_CAPABILITY_REQUIRED');
  let runId = activeRunFor(capability, { includeSealed: true });
  let initial = runId ? loadState(runId) : null;
  if (!initial?.child_receipts?.[receiptId]) {
    const index = readJson(receiptIndexPath(receiptId), null);
    assert(index?.receipt_id === receiptId && index.run_id, 'CHILD_RECEIPT_NOT_FOUND');
    runId = index.run_id;
    initial = loadState(runId);
    assert(initial.sealed, 'CHILD_RECEIPT_NOT_SEALED');
  }
  assert(initial.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    if (current.sealed) repairSeal(runId);
    const receipt = current.child_receipts[receiptId];
    assert(receipt, 'CHILD_RECEIPT_NOT_FOUND');
    const content = readFileSync(childReceiptPath(runId, receiptId), 'utf8');
    assert(receipt.content_hash === sha256(content), 'LOCAL_CHAIN_BROKEN');
    if (current.sealed) return JSON.parse(content);
    appendEventUnlocked(runId, current, {
      type: 'child_receipt_retrieved',
      origin: 'mcp_routed',
      payload: { receipt_id: receiptId, content_ref: sha256(content) },
      idempotencyKey: `child-read:${receiptId}`
    });
    current.child_receipts[receiptId].retrieved = true;
    const evaluation = Object.values(current.evaluations).find((item) => item.child_receipt_id === receiptId);
    if (evaluation) evaluation.child_receipt_retrieved = true;
    saveState(current);
    return JSON.parse(content);
  });
}

export function checkpointOrSeal(capability, deliveryKey = null) {
  const runId = activeRunFor(capability);
  if (!runId) return { status: 'NO_ACTIVE_RUN' };
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    // Adopt a durable terminal run_sealed (crash after the seal append, before state/anchor) BEFORE the
    // replay guard, which would otherwise short-circuit and leave an unsealed run no later Stop repairs.
    const { events: preEvents } = adoptTerminalLedgerSeal(runId, current);
    if (current.sealed) {
      return repairSeal(runId);
    }
    // Every Stop records exactly one delivery-keyed turn_checkpoint — the "a Stop boundary was
    // observed" fact — and repeated-hook idempotency (SPEC) requires a replayed Stop to NOT re-observe
    // the run: no new close_deferred, no seal. A replay is identified by its delivery-keyed checkpoint
    // ALREADY existing in the ledger, checked before anything is appended. (Inferring it from tip
    // position would miss the crash window where the turn_checkpoint was appended and state saved but
    // the closeout never ran — the dup would still be the tip, so a redelivery would wrongly seal.)
    const checkpointKey = `checkpoint:${deliveryKey || preEvents.length + 1}`;
    const priorCheckpoint = preEvents.find((event) => event.idempotency_key === checkpointKey);
    if (priorCheckpoint) {
      // The Stop was observed. If the original delivery crashed after appending the turn_checkpoint
      // but before writeCheckpointArtifacts wrote the packet, no checkpoint_anchor follows it — finish
      // that interrupted packet now so every observed Stop has its verifiable checkpoint. If an anchor
      // already follows this checkpoint the packet is complete; do NOT re-anchor (that would fold later
      // activity into a fresh anchor for a repeated hook). Never re-seal or re-defer.
      const packetComplete = preEvents.some((event) => event.type === 'checkpoint_anchor' && event.seq > priorCheckpoint.seq);
      if (!packetComplete) writeCheckpointArtifacts(runId, current);
      return { status: current.close_requested ? 'CLOSE_DEFERRED' : 'CHECKPOINTED', run_id: runId, replayed_delivery: true };
    }
    appendEventUnlocked(runId, current, {
      type: 'turn_checkpoint',
      origin: 'runtime_hook',
      // The renderer version rides in this event for observability; the verification gate reads the
      // checkpoint_anchor event that writeCheckpointArtifacts appends (never the mutable anchor
      // file), mirroring how run_sealed pins the seal renderer.
      payload: { status: 'OPEN', receipt_renderer: ADAPTER_VERSION },
      idempotencyKey: checkpointKey
    });
    saveState(current);
    if (!current.close_requested) {
      writeCheckpointArtifacts(runId, current);
      return { status: 'CHECKPOINTED', run_id: runId };
    }
    const evaluations = Object.values(current.evaluations);
    const closingSnapshots = Object.values(current.pr_snapshots).filter((snapshot) => snapshot.status === 'CONSISTENT');
    const blockers = [];
    if (!closingSnapshots.length) blockers.push('PR_SNAPSHOT_REQUIRED');
    for (const snapshot of closingSnapshots) {
      const snapshotEvaluations = evaluations.filter((evaluation) => evaluation.snapshot_id === snapshot.id && evaluation.status !== 'STALE');
      if (!snapshotEvaluations.length) {
        blockers.push(`EVALUATION_${snapshot.id}_REQUIRED`);
        continue;
      }
      for (const evaluation of snapshotEvaluations) {
        if (!['RECORDED', 'CHECKOUT_INTEGRITY_EXCEPTION'].includes(evaluation.status)) blockers.push(`EVALUATION_${evaluation.id}_${evaluation.status}`);
        if (!evaluation.child_receipt_id) blockers.push(`CHILD_RECEIPT_${evaluation.id}_OPEN`);
        if (!evaluation.child_receipt_retrieved) blockers.push(`CHILD_RECEIPT_${evaluation.id}_NOT_RETRIEVED`);
      }
    }
    for (const child of Object.values(current.children || {})) {
      if (child.status !== 'STOP_OBSERVED' || !child.receipt_id) {
        blockers.push(`CHILD_${child.id}_OPEN`);
      }
    }
    if (blockers.length) {
      blockers.sort();
      // This Stop is newly observed (a replay returned above). A blocker set identical to the LATEST
      // close_deferred observation appends no new close_deferred; any changed set — including one that
      // recurs after an intervening different set (the prior-occurrence count keys it) — is a
      // semantically distinct observation and appends its own event, so the lifecycle face's latest
      // close_deferred is always the latest observation.
      const { events: parsedEvents } = parseLedger(runId);
      const priorDeferred = parsedEvents.filter((event) => event.type === 'close_deferred');
      const latestDeferred = priorDeferred.at(-1);
      if (!latestDeferred || canonicalJson(latestDeferred.payload.blockers) !== canonicalJson(blockers)) {
        appendEventUnlocked(runId, current, {
          type: 'close_deferred',
          origin: 'runtime_hook',
          payload: { blockers, receipt_renderer: ADAPTER_VERSION },
          idempotencyKey: `close-deferred:o${priorDeferred.length}:${sha256(canonicalJson(blockers))}`
        });
      }
      saveState(current);
      // The deferred close is this newly observed Stop's checkpoint — anchor it.
      writeCheckpointArtifacts(runId, current);
      return { status: 'CLOSE_DEFERRED', run_id: runId, blockers };
    }
    appendEventUnlocked(runId, current, {
      type: 'run_sealed',
      origin: 'runtime_hook',
      // The renderer version lives in the hash-chained ledger, not only in the mutable
      // anchor file, so verification's renderer gate cannot be downgraded by editing the anchor.
      payload: { status: 'SEALED', receipt_renderer: ADAPTER_VERSION },
      idempotencyKey: `seal:${runId}`
    });
    const { events, tip } = parseLedger(runId);
    stripLegacyChildReceiptPaths(current);
    current.sealed = true;
    current.ledger_count = events.length;
    current.ledger_tip = tip;
    saveState(current);
    const receiptJson = renderReceiptJson(current, events);
    const receiptMarkdown = renderReceiptMarkdown(current, events);
    atomicWriteText(join(runDir(runId), 'receipt.json'), receiptJson);
    atomicWriteText(join(runDir(runId), 'RECEIPT.md'), receiptMarkdown);
    atomicWriteJson(anchorPath(runId), {
      run_id: runId,
      final_seq: current.ledger_count,
      final_hash: current.ledger_tip,
      state_hash: sha256(canonicalJson(current)),
      receipt_json_hash: sha256(receiptJson),
      receipt_markdown_hash: sha256(receiptMarkdown),
      receipt_renderer: ADAPTER_VERSION
    });
    // CZ-14 decision: a sealed packet carries exactly one anchor — remove the checkpoint anchor
    // written by earlier Stops. repairSeal tolerates both presence (interrupted seal) and absence.
    dropCheckpointAnchor(runId);
    return { status: 'SEALED', run_id: runId, receipt_path: join(runDir(runId), 'RECEIPT.md') };
  });
}

// CZ-14 seal-as-you-go. The ledger is the trust root for open packets: after the Stop's
// checkpoint/close_deferred event is appended, the rendered receipt's hashes are committed to a
// hash-chained checkpoint_anchor EVENT, and only then are the receipt files and the convenience
// checkpoint-anchor.json written. Editing the mutable anchor file or the receipt files can
// therefore never select a weaker verification path — verification reads the anchor event. The
// receipt covers events 1..covers_seq (everything before its own anchor event); the latest anchor
// overwrites the file, history lives in the ledger. Called only after the checkpoint/close_deferred
// event is appended and state saved, so the parsed ledger and the passed state agree.
function writeCheckpointArtifacts(runId, state) {
  const { events, tip } = parseLedger(runId);
  // Nothing happened since the previous anchor (e.g. a redelivered Stop deduped its checkpoint
  // event): the ledger tip IS the anchor; re-anchoring would anchor the anchor. Idempotent no-op.
  if (events.at(-1)?.type === 'checkpoint_anchor') return;
  const coversSeq = events.length;
  const receiptJson = renderReceiptJson(state, events);
  const receiptMarkdown = renderReceiptMarkdown(state, events);
  const stateHash = sha256(canonicalJson(state));
  const receiptJsonHash = sha256(receiptJson);
  const receiptMarkdownHash = sha256(receiptMarkdown);
  const anchorEvent = appendEventUnlocked(runId, state, {
    type: 'checkpoint_anchor',
    origin: 'runtime_hook',
    payload: {
      covers_seq: coversSeq,
      tip_hash: tip,
      state_hash: stateHash,
      receipt_json_hash: receiptJsonHash,
      receipt_markdown_hash: receiptMarkdownHash,
      receipt_renderer: ADAPTER_VERSION
    },
    idempotencyKey: `checkpoint-anchor:${coversSeq}`
  });
  saveState(state);
  atomicWriteText(join(runDir(runId), 'receipt.json'), receiptJson);
  atomicWriteText(join(runDir(runId), 'RECEIPT.md'), receiptMarkdown);
  atomicWriteJson(checkpointAnchorPath(runId), {
    run_id: runId,
    as_of_seq: coversSeq,
    anchor_event_seq: anchorEvent.seq,
    tip_hash: tip,
    state_hash: stateHash,
    receipt_json_hash: receiptJsonHash,
    receipt_markdown_hash: receiptMarkdownHash,
    receipt_renderer: ADAPTER_VERSION
  });
}

export function verifySealedRun(runId) {
  return withLock(lockPath(runId), () => repairSeal(runId));
}

function checkpointReceiptFilesMatch(runId, payload) {
  const jsonPath = join(runDir(runId), 'receipt.json');
  const markdownPath = join(runDir(runId), 'RECEIPT.md');
  return existsSync(jsonPath)
    && sha256(readFileSync(jsonPath, 'utf8')) === payload.receipt_json_hash
    && existsSync(markdownPath)
    && sha256(readFileSync(markdownPath, 'utf8')) === payload.receipt_markdown_hash;
}

// CZ-14 open-packet verification. An unsealed run with checkpoint anchors is a verifiable packet at
// its last checkpoint. The trust root is the hash-chained ledger: receipt hashes are read from the
// latest checkpoint_anchor EVENT, so editing the mutable checkpoint-anchor.json or the receipt files
// can never select a weaker path, and deleting the anchor file hides nothing. Verifies: the whole
// chain; state-cache/ledger consistency; that the on-disk receipt files are the exact bytes some
// committed anchor event covers — scanning newest-first so a torn write on a later checkpoint (anchor
// appended, crash before its file writes) reports structurally at the earlier intact packet, never as
// tamper, and absent receipt files (a torn/incomplete write, including the first checkpoint) report a
// structural CHECKPOINT_INCOMPLETE with whether the bytes remain reconstructable from the ledger;
// agreement of the convenience anchor file, when present, with the committed anchor event it names
// (tolerating a one-write lag, since that file is a cache, not a trust root); and, when the ledger
// has not advanced past the anchor event and the ledger pins the current renderer, that re-rendering
// reproduces the anchored bytes and state hash exactly.
function verifyOpenPacket(runId) {
  const state = loadState(runId);
  assert(!state.sealed, 'RUN_SEALED');
  const { events } = parseLedger(runId);
  // The state cache must be a consistent prefix view of the ledger — it may lag after a crash
  // (readLedger recovers that), but it must never contradict the chain.
  assert(
    Number.isInteger(state.ledger_count) && state.ledger_count >= 0 && state.ledger_count <= events.length,
    'LOCAL_CHAIN_BROKEN'
  );
  const cacheTip = state.ledger_count === 0 ? ZERO_HASH : events[state.ledger_count - 1].event_hash;
  assert(cacheTip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  // Child receipts are sealed to their own files during the run and named by the state; an open
  // packet must hash-check them exactly as the sealed path does, so a corrupted or deleted child
  // artifact cannot hide behind an otherwise-valid parent checkpoint.
  verifyChildReceipts(state);
  const anchorEvents = events.filter((event) => event.type === 'checkpoint_anchor');
  if (!anchorEvents.length) {
    // Legacy / pre-CZ-14 open shape (or a run that never reached a Stop): structural, never a throw.
    return { status: 'OPEN_NO_CHECKPOINT', run_id: runId, event_count: events.length };
  }
  const verifiedPayload = (anchorEvent) => {
    const payload = anchorEvent.payload || {};
    assert(
      Number.isInteger(payload.covers_seq)
      && payload.covers_seq === anchorEvent.seq - 1
      && payload.covers_seq >= 1
      && events[payload.covers_seq - 1].event_hash === payload.tip_hash
      && typeof payload.state_hash === 'string'
      && typeof payload.receipt_json_hash === 'string'
      && typeof payload.receipt_markdown_hash === 'string',
      'LOCAL_CHAIN_BROKEN'
    );
    return payload;
  };
  // The checkpoint-anchor.json file is a convenience MIRROR of a checkpoint_anchor event, never a
  // trust root — every gating hash is read from the ledger, never from this file. It may legitimately
  // lag one write behind: writeCheckpointArtifacts renames both receipt files before rewriting this
  // file, so a crash in that window leaves the receipt files on the LATEST anchor while this file
  // still names the PRIOR one. Validate it against the anchor EVENT it names (stale-but-valid is
  // fine); a file naming no committed anchor, or disagreeing with the one it names, is an incoherent
  // on-disk cache and fails closed — including in the torn-write branch, so a corrupted cache is
  // never hidden by an incomplete write.
  const assertAnchorFileCoherent = () => {
    const anchorFilePath = checkpointAnchorPath(runId);
    if (!existsSync(anchorFilePath)) return;
    let anchorFile;
    // A present-but-malformed cache is local corruption — a structural LOCAL_CHAIN_BROKEN, never a
    // raw Node SyntaxError leaking out of the verifier.
    try {
      anchorFile = JSON.parse(readFileSync(anchorFilePath, 'utf8'));
    } catch {
      assert(false, 'LOCAL_CHAIN_BROKEN');
    }
    const named = anchorEvents.find((event) => event.seq === anchorFile.anchor_event_seq);
    assert(named, 'LOCAL_CHAIN_BROKEN');
    const namedPayload = verifiedPayload(named);
    assert(
      anchorFile.run_id === runId
      && anchorFile.as_of_seq === namedPayload.covers_seq
      && anchorFile.tip_hash === namedPayload.tip_hash
      && anchorFile.state_hash === namedPayload.state_hash
      && anchorFile.receipt_json_hash === namedPayload.receipt_json_hash
      && anchorFile.receipt_markdown_hash === namedPayload.receipt_markdown_hash,
      'LOCAL_CHAIN_BROKEN'
    );
  };
  const latest = anchorEvents.at(-1);
  const latestPayload = verifiedPayload(latest);
  // Which ledger-committed anchor do BOTH on-disk receipt files reproduce? Normally the latest. A
  // torn write on a LATER checkpoint (anchor event appended, crash before its file writes) leaves the
  // files holding an earlier anchor's packet — scan newest-first and report at that one; the next
  // Stop heals the split.
  const allPayloads = anchorEvents.map((event) => verifiedPayload(event));
  let matched = null;
  let matchedPayload = null;
  for (let index = anchorEvents.length - 1; index >= 0; index -= 1) {
    if (checkpointReceiptFilesMatch(runId, allPayloads[index])) {
      matched = anchorEvents[index];
      matchedPayload = allPayloads[index];
      break;
    }
  }
  if (!matched) {
    // No single committed anchor is reproduced by both files. This is a torn/incomplete write —
    // benign — UNLESS a present file's content is vouched for by no committed anchor at all, which is
    // tamper. A file is checked per-slot against every committed anchor's hash: absent slots are an
    // unwritten/torn write (the first checkpoint has no earlier packet to fall back to), a mixed
    // pair is a crash between the two atomic renames, and either way the ledger-pinned anchor plus
    // the current deterministic renderer can reconstruct the bytes. Torn writes report a structural
    // CHECKPOINT_INCOMPLETE, never tamper and never a raw filesystem error.
    const jsonHashes = new Set(allPayloads.map((payload) => payload.receipt_json_hash));
    const markdownHashes = new Set(allPayloads.map((payload) => payload.receipt_markdown_hash));
    const jsonPath = join(runDir(runId), 'receipt.json');
    const markdownPath = join(runDir(runId), 'RECEIPT.md');
    if (existsSync(jsonPath)) assert(jsonHashes.has(sha256(readFileSync(jsonPath, 'utf8'))), 'LOCAL_CHAIN_BROKEN');
    if (existsSync(markdownPath)) assert(markdownHashes.has(sha256(readFileSync(markdownPath, 'utf8'))), 'LOCAL_CHAIN_BROKEN');
    // A corrupted anchor cache must surface even in the incomplete-write case, not be hidden by it.
    assertAnchorFileCoherent();
    let reproducible = false;
    if (events.length === latest.seq && latestPayload.receipt_renderer === ADAPTER_VERSION) {
      const stateAtAnchor = { ...state, ledger_count: latestPayload.covers_seq, ledger_tip: latestPayload.tip_hash };
      assert(sha256(canonicalJson(stateAtAnchor)) === latestPayload.state_hash, 'LOCAL_CHAIN_BROKEN');
      const covered = events.slice(0, latestPayload.covers_seq);
      assert(sha256(renderReceiptJson(stateAtAnchor, covered)) === latestPayload.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(sha256(renderReceiptMarkdown(stateAtAnchor, covered)) === latestPayload.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
      reproducible = true;
    }
    return {
      status: 'CHECKPOINT_INCOMPLETE',
      run_id: runId,
      as_of_seq: latestPayload.covers_seq,
      anchor_event_seq: latest.seq,
      content_reproducible_from_ledger: reproducible
    };
  }
  assertAnchorFileCoherent();
  if (events.length === matched.seq) {
    // Ledger exactly at the anchor: the current state minus the anchor event itself must reproduce
    // the committed state hash, and the current renderer must reproduce the committed bytes.
    const stateAtAnchor = { ...state, ledger_count: matchedPayload.covers_seq, ledger_tip: matchedPayload.tip_hash };
    assert(sha256(canonicalJson(stateAtAnchor)) === matchedPayload.state_hash, 'LOCAL_CHAIN_BROKEN');
    if (matchedPayload.receipt_renderer === ADAPTER_VERSION) {
      const covered = events.slice(0, matchedPayload.covers_seq);
      assert(sha256(renderReceiptJson(stateAtAnchor, covered)) === matchedPayload.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
      assert(sha256(renderReceiptMarkdown(stateAtAnchor, covered)) === matchedPayload.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
    }
  }
  return {
    status: 'CHECKPOINT_VERIFIED',
    run_id: runId,
    as_of_seq: matchedPayload.covers_seq,
    anchor_event_seq: matched.seq,
    latest_anchor_event_seq: latest.seq,
    files_match_latest_anchor: matched === latest,
    ledger_advanced: events.length > latest.seq
  };
}

// Dispatching verify: sealed runs keep verifySealedRun semantics unchanged; unsealed runs verify their
// open packet (checkpoint anchor) or return the legacy structural result.
export function verifyRun(runId) {
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    // A reader calling verifyRun before any hook redelivery must not misclassify a durable-sealed
    // ledger as open: adopt a terminal run_sealed (the same source of truth checkpointOrSeal uses),
    // then route sealed runs to repairSeal.
    adoptTerminalLedgerSeal(runId, state);
    return state.sealed ? repairSeal(runId) : verifyOpenPacket(runId);
  });
}

// CZ-11: a syntactically plausible but unknown capability is a rejected claim, not silence.
// Record a value-free trace (error code only) so a reader can distinguish "never claimed"
// from "claimed and the recording failed". No statement text, no content.
export function recordRejectedClaim(capability) {
  try {
    const match = typeof capability === 'string' ? capability.match(CAPABILITY_SHAPE) : null;
    if (!match) return null;
    const kind = match[1];
    const capabilityRef = sha256(capability);
    const active = readJson(activePath(capability), null);
    const runId = active?.run_id || null;
    const mapped = runId ? readJson(statePath(runId), null) : null;
    if (runId && mapped && !mapped.sealed) {
      return withLock(lockPath(runId), () => {
        const current = loadState(runId);
        if (current.sealed) return writeRejectedClaimMarker(capabilityRef, kind);
        appendEventUnlocked(runId, current, {
          type: 'claim_rejected',
          origin: 'mcp_routed',
          payload: { code: 'UNKNOWN_CAPABILITY', capability_kind: kind },
          idempotencyKey: `claim-rejected:${capabilityRef}`
        });
        saveState(current);
        return { recorded: 'run', run_id: runId };
      });
    }
    return writeRejectedClaimMarker(capabilityRef, kind);
  } catch {
    return null;
  }
}

const REJECTED_CLAIM_LIMIT = 32;

function writeRejectedClaimMarker(capabilityRef, kind) {
  const markerDir = join(root(), 'claim-rejected');
  const fileName = `claim-${capabilityRef.slice(0, 16)}.json`;
  let existing = [];
  try { existing = readdirSync(markerDir); } catch { existing = []; }
  if (existing.length >= REJECTED_CLAIM_LIMIT && !existing.includes(fileName)) return null;
  // CZ-11: the marker carries error code + capability kind only. The ref lives in the filename,
  // not the content, so a reader cannot correlate the marker back to a capability value.
  atomicWriteJson(claimRejectedMarkerPath(capabilityRef), {
    code: 'UNKNOWN_CAPABILITY',
    capability_kind: kind
  });
  return { recorded: 'marker', ref: capabilityRef };
}

export function getRunForTesting(runId) {
  const events = readLedger(runId);
  return { state: loadState(runId), events, directory: runDir(runId) };
}
