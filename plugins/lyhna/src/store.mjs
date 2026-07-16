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

const ZERO_HASH = '0'.repeat(64);
const CONFIGURED_HOOKS = ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];

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

function receiptIndexPath(receiptId) {
  return join(root(), 'receipt-index', `${sha256(receiptId)}.json`);
}

function sessionLockPath(capability) {
  return join(root(), 'session-locks', `${sha256(capability)}.lock`);
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

function repairSeal(runId) {
  const state = loadState(runId);
  assert(state.sealed, 'RUN_NOT_SEALED');
  const { events, tip } = parseLedger(runId);
  assert(events.length === state.ledger_count && tip === state.ledger_tip, 'LOCAL_CHAIN_BROKEN');
  verifyChildReceipts(state);
  const receiptJson = renderReceiptJson(state, events);
  const receiptMarkdown = renderReceiptMarkdown(state, events);
  const expected = {
    run_id: runId,
    final_seq: events.length,
    final_hash: tip,
    state_hash: sha256(canonicalJson(state)),
    receipt_json_hash: sha256(receiptJson),
    receipt_markdown_hash: sha256(receiptMarkdown)
  };
  const anchor = readJson(anchorPath(runId), null);
  if (anchor) assert(canonicalJson(anchor) === canonicalJson(expected), 'LOCAL_CHAIN_BROKEN');
  const jsonPath = join(runDir(runId), 'receipt.json');
  const markdownPath = join(runDir(runId), 'RECEIPT.md');
  if (existsSync(jsonPath)) assert(sha256(readFileSync(jsonPath, 'utf8')) === expected.receipt_json_hash, 'LOCAL_CHAIN_BROKEN');
  else atomicWriteText(jsonPath, receiptJson);
  if (existsSync(markdownPath)) assert(sha256(readFileSync(markdownPath, 'utf8')) === expected.receipt_markdown_hash, 'LOCAL_CHAIN_BROKEN');
  else atomicWriteText(markdownPath, receiptMarkdown);
  if (!anchor) atomicWriteJson(anchorPath(runId), expected);
  return { status: 'ALREADY_SEALED', run_id: runId, receipt_path: join(runDir(runId), 'RECEIPT.md') };
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
      pr_snapshots: {},
      evaluations: {},
      children: {},
      child_receipts: {}
    };
    mkdirSync(runDir(runId), { recursive: true });
    const runBegunPayload = { mode, objective_origin: state.objective_origin };
    if (pending) runBegunPayload.invocation = { matched_form: pending.matched_form, mention_offset: pending.mention_offset };
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
    if (pending) rmSync(pendingPath, { force: true });
    return state;
  });
}

const INVOCATION_NON_BOUNDARY_BEFORE = /[a-z0-9@]/i;
const INVOCATION_STRUCTURED = /^\[@?lyhna[^\]]*\]\(plugin:\/\/lyhna-codex-adapter(?=[^a-z0-9_-])[^)]*\)/i;
const INVOCATION_URI = /plugin:\/\/lyhna-codex-adapter(?=$|[^a-z0-9_-])/i;
const INVOCATION_LITERAL_LONG = /^@lyhna-codex-adapter(?:@[a-z0-9-]+)?(?=$|[^a-z0-9_-])/i;
const INVOCATION_LITERAL_SHORT = /^@lyhna(?=$|[^a-z0-9_-])/i;
const INVOCATION_LITERAL_DOLLAR = /^\$lyhna(?=$|[^a-z0-9_-])/i;

function detectInvocation(promptText) {
  for (let index = 0; index < promptText.length; index += 1) {
    const rest = promptText.slice(index);
    if (INVOCATION_STRUCTURED.test(rest)) return { matched_form: 'structured', mention_offset: index };
    if (index !== 0 && INVOCATION_NON_BOUNDARY_BEFORE.test(promptText[index - 1])) continue;
    if (INVOCATION_LITERAL_LONG.test(rest)) return { matched_form: 'literal_long', mention_offset: index };
    if (INVOCATION_LITERAL_SHORT.test(rest)) return { matched_form: 'literal_short', mention_offset: index };
    if (INVOCATION_LITERAL_DOLLAR.test(rest)) return { matched_form: 'literal_dollar', mention_offset: index };
  }
  const uriMatch = INVOCATION_URI.exec(promptText);
  if (uriMatch) return { matched_form: 'structured', mention_offset: uriMatch.index };
  return null;
}

function maskedMentionContexts(promptText) {
  const contexts = [];
  const pattern = /lyhna/gi;
  let match;
  while ((match = pattern.exec(promptText)) && contexts.length < 8) {
    const start = Math.max(0, match.index - 16);
    const end = Math.min(promptText.length, match.index + match[0].length + 16);
    contexts.push(promptText.slice(start, end).replace(/[a-z0-9]/gi, (ch) => (/[0-9]/.test(ch) ? '9' : ch === ch.toUpperCase() ? 'A' : 'a')));
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

export function addPrSnapshot(capability, snapshot) {
  const { runId } = requireParent(capability);
  const id = snapshot.id || `pr_${sha256(canonicalJson({ runId, snapshot })).slice(0, 24)}`;
  const normalized = { ...snapshot, id };
  return withLock(lockPath(runId), () => {
    const state = loadState(runId);
    assert(!state.sealed && state.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
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
    state.pr_snapshots[id] = normalized;
    saveState(state);
    return normalized;
  });
}

export function beginEvaluation(capability, snapshotId, checkout = {}) {
  const { runId } = requireParent(capability);
  return withLock(lockPath(runId), () => {
    const current = loadState(runId);
    assert(!current.sealed && current.parent_capability_hash === sha256(capability), 'CAPABILITY_RUN_MISMATCH');
    const snapshot = current.pr_snapshots[snapshotId];
    assert(snapshot, 'SNAPSHOT_NOT_FOUND');
    assert(snapshot.status === 'CONSISTENT', 'INCONSISTENT_SNAPSHOT');
    assert(checkout.path && checkout.head === snapshot.head_after && checkout.clean === true && checkout.detached === true, 'EVALUATOR_CHECKOUT_REQUIRED');
    const existing = Object.values(current.evaluations).find((item) => item.snapshot_id === snapshotId && !['STALE', 'INVALID'].includes(item.status));
    if (existing) return existing;
    const id = `eval_${sha256(`${runId}:${snapshotId}`).slice(0, 24)}`;
    appendEventUnlocked(runId, current, {
      type: 'evaluation_requested',
      origin: 'mcp_routed',
      payload: { evaluation_request_id: id, snapshot_id: snapshotId, expected_head: snapshot.head_after },
      idempotencyKey: `evaluation-request:${id}`
    });
    current.evaluations[id] = {
      id,
      snapshot_id: snapshotId,
      expected_head: snapshot.head_after,
      status: 'OPEN',
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
    appendEventUnlocked(runId, current, {
      type: 'pr_refreshed',
      origin: 'github_observed',
      payload: { snapshot_id: snapshotId, observed_head: currentHead, status: stale ? 'STALE' : 'CURRENT_AT_REFRESH' },
      idempotencyKey: `refresh:${snapshotId}:${currentHead}`
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
    if (current.sealed) {
      const repaired = repairSeal(runId);
      return repaired;
    }
    if (!current.close_requested) {
      appendEventUnlocked(runId, current, {
        type: 'turn_checkpoint',
        origin: 'runtime_hook',
        payload: { status: 'OPEN' },
        idempotencyKey: `checkpoint:${deliveryKey || current.ledger_count + 1}`
      });
      saveState(current);
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
      appendEventUnlocked(runId, current, {
        type: 'close_deferred',
        origin: 'runtime_hook',
        payload: { blockers },
        idempotencyKey: `close-deferred:${sha256(canonicalJson(blockers))}`
      });
      saveState(current);
      return { status: 'CLOSE_DEFERRED', run_id: runId, blockers };
    }
    appendEventUnlocked(runId, current, {
      type: 'run_sealed',
      origin: 'runtime_hook',
      payload: { status: 'SEALED' },
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
      receipt_markdown_hash: sha256(receiptMarkdown)
    });
    return { status: 'SEALED', run_id: runId, receipt_path: join(runDir(runId), 'RECEIPT.md') };
  });
}

export function verifySealedRun(runId) {
  return withLock(lockPath(runId), () => repairSeal(runId));
}

export function getRunForTesting(runId) {
  const events = readLedger(runId);
  return { state: loadState(runId), events, directory: runDir(runId) };
}
