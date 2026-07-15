import { canonicalJson, sha256 } from './util.mjs';

const SECRET_KEY = /(^|_)(token|secret|password|passwd|authorization|api[_-]?key|cookie|env|environment)($|_)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+\/-]+|basic\s+[a-z0-9+/=]+|(?:sk|ghp|github_pat|xox[baprs])-?[a-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;
const ASSIGNED_SECRET = /\b(password|passwd|authorization|api[_-]?key|token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CREDENTIAL_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s/@:]+:[^@\s]+@[^\s]+/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

export function redactSecrets(value) {
  return String(value ?? '')
    .replace(CREDENTIAL_URL, '[REDACTED_CREDENTIAL_URL]')
    .replace(AWS_ACCESS_KEY, '[REDACTED_AWS_KEY]')
    .replace(SECRET_VALUE, '[REDACTED]')
    .replace(ASSIGNED_SECRET, (_match, key) => `${key}=[REDACTED]`)
    .replace(/lyhna_(?:session|child)_[a-f0-9]{32,}/gi, '[REDACTED_CAPABILITY]');
}

export function boundedText(value, max = 160) {
  const text = redactSecrets(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function structuralSummary(value, label = 'Free-form text') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return `${label} not supplied.`;
  return `${label} retained by hash (${text.split(' ').length} words, ${Buffer.byteLength(text)} bytes).`;
}

export function promptSynopsis(value) {
  return structuralSummary(value, 'Invocation objective');
}

export function reference(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return { sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

export function safeSummary(value, depth = 0) {
  if (depth > 3) return { kind: 'truncated', ref: reference(value) };
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return { summary: boundedText(value), ref: reference(value) };
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      count: value.length,
      items: value.slice(0, 10).map((item) => safeSummary(item, depth + 1)),
      ref: reference(value)
    };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const key of Object.keys(value).sort().slice(0, 30)) {
      fields[key] = SECRET_KEY.test(key) ? '[REDACTED]' : safeSummary(value[key], depth + 1);
    }
    return { kind: 'object', fields, ref: reference(value) };
  }
  return { kind: typeof value, ref: reference(String(value)) };
}

export function sanitizeHook(input) {
  const event = boundedText(input.hook_event_name || input.event_name || 'UnknownHook', 60);
  const toolName = boundedText(input.tool_name || input.tool || input.name || '', 100);
  const eventId = boundedText(input.event_id || input.tool_use_id || input.call_id || '', 160);
  const outcome = event === 'PostToolUse'
    ? boundedText(input.outcome || input.status || (input.error ? 'error' : 'returned'), 60)
    : undefined;
  const payload = {
    event,
    event_id: eventId || null,
    model: boundedText(input.model || '', 100) || null,
    tool_name: toolName || null,
    cwd_ref: input.cwd ? reference(String(input.cwd)) : null,
    payload_ref: reference(input)
  };
  if (event === 'PreToolUse') payload.support = 'attempt_observed';
  if (event === 'PostToolUse') {
    payload.support = 'tool_returned';
    payload.outcome = outcome;
  }
  if (event === 'PermissionRequest') payload.support = 'permission_observed_not_execution';
  if (event === 'SessionStart' || event === 'SubagentStart' || event === 'SubagentStop' || event === 'Stop') {
    payload.support = 'lifecycle_observed_not_execution';
  }
  return payload;
}

export function sanitizeClaim(statement, evidenceRefs = []) {
  return {
    statement: structuralSummary(statement, 'Attributed statement'),
    statement_ref: reference(statement),
    evidence_refs: [...new Set(evidenceRefs.map((item) => `sha256:${sha256(String(item))}`))].sort()
  };
}
