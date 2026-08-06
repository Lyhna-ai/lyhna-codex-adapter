import { readFileSync } from 'node:fs';
import { sha256 } from '../src/util.mjs';
import { sanitizeHook } from '../src/redact.mjs';
import {
  activeRunFor,
  checkpointOrSeal,
  claimInlineAdvisory,
  findParentCapabilityBySession,
  mintChild,
  mintSession,
  recordHookForParent,
  rememberInvocation,
  sealChildByAgent
} from '../src/store.mjs';

function contextOutput(eventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text
    }
  };
}

function readInput() {
  const raw = readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function main(input) {
  const event = input.hook_event_name || input.event_name || '';
  if (event === 'SessionStart') {
    const capability = mintSession({ sessionId: input.session_id, cwd: input.cwd, model: input.model });
    return contextOutput('SessionStart', `Lyhna is available only when explicitly invoked. For an invoked run, use LYHNA_SESSION_CAPABILITY=${capability}. This capability is bound to the hook-observed parent session; do not disclose it outside Lyhna tool calls.`);
  }

  if (event === 'UserPromptSubmit') rememberInvocation({ sessionId: input.session_id, prompt: input.prompt || input.user_prompt || input.message });

  const parentCapability = findParentCapabilityBySession(input.session_id);
  const payload = sanitizeHook(input);
  const deliveryKey = input.event_id || input.tool_use_id || input.call_id || sha256(JSON.stringify(payload));
  // SubagentStart/Stop record their own child-lifecycle events; Stop records its single durable
  // marker atomically inside checkpointOrSeal (the delivery-keyed turn_checkpoint IS the Stop
  // observation). Recording a separate hook_stop here would make the Stop marker span two
  // non-atomic appends, so a crash between them could let a redelivered Stop reach the seal path
  // after blockers cleared. Excluding Stop keeps the turn_checkpoint the sole, first-written marker.
  const ownsOwnRecord = event === 'SubagentStart' || event === 'SubagentStop' || event === 'Stop';
  if (parentCapability && activeRunFor(parentCapability) && !ownsOwnRecord) {
    recordHookForParent(parentCapability, payload, `hook:${event}:${deliveryKey}`);
  }

  if (event === 'SubagentStart') {
    const child = mintChild({
      sessionId: input.session_id,
      agentId: input.agent_id,
      hookPayload: payload,
      hookDeliveryKey: `hook:${event}:${deliveryKey}`
    });
    if (child) return contextOutput('SubagentStart', `This child has a hook-issued Lyhna identity. Use LYHNA_CHILD_CAPABILITY=${child} only for an assigned evaluator request. It cannot act as the parent builder.`);
  }

  if (event === 'SubagentStop') {
    sealChildByAgent({
      sessionId: input.session_id,
      agentId: input.agent_id,
      hookPayload: payload,
      hookDeliveryKey: `hook:${event}:${deliveryKey}`
    });
  }
  if (event === 'PostToolUse' && parentCapability) {
    const advisory = claimInlineAdvisory(parentCapability);
    if (advisory) return contextOutput('PostToolUse', advisory);
  }
  if (event === 'Stop' && parentCapability) {
    const deliveryKey = input.event_id || input.turn_id || sha256(JSON.stringify(sanitizeHook(input)));
    const result = checkpointOrSeal(parentCapability, deliveryKey);
    if (result?.decision === 'block') return { decision: 'block', reason: result.reason };
  }
  return {};
}

let hookInput = {};
try {
  hookInput = readInput();
  process.stdout.write(`${JSON.stringify(main(hookInput))}\n`);
} catch (error) {
  const code = error.code || 'HOOK_ERROR';
  if ((hookInput.hook_event_name || hookInput.event_name) === 'Stop' && error.lyhnaClaimBoundary === true) {
    process.stdout.write(`${JSON.stringify({
      decision: 'block',
      reason: `BLOCKED_TRANSPORT: Lyhna could not persist or verify the closeout boundary (${code}). The run remains unsupported; repair transport or ledger integrity before closing.`
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Lyhna hook did not record this event (${code}). No execution claim was created.` })}\n`);
  }
}
