// HANDOFF.md — the paste-into-the-next-window face of the Continuation Capsule.
//
// A human working across several context windows switches when the window gets expensive, not
// when the work reaches a natural boundary. The cost of switching is re-explaining, and the risk
// of switching is silent drift: each hand-written handoff is the agent's own summary of itself,
// so errors compound window over window until the thread is no longer describing the same project.
//
// This renderer produces the artifact that removes both. It carries no new content — every line
// is already in the capsule, which was folded from the hash-chained ledger by the supervisor hook
// path. The agent cannot add to it, soften it, or drop an inconvenient open item.
//
// Deterministic by construction: the capsule is deterministic and this is a pure projection of it.

const SUPPORT_MARK = {
  SUPPORTED: 'SUPPORTED',
  UNSUPPORTED: 'UNSUPPORTED',
  UNRESOLVED_EVIDENCE: 'UNRESOLVED EVIDENCE'
};

/**
 * The prompt a human pastes into the next window. It deliberately points the next agent at the
 * capsule rather than at prose: prose is what drifts. The instruction to treat unsupported claims
 * as unverified is the whole point of the artifact.
 */
export function buildHandoffPrompt(capsule) {
  const unsupported = capsule.claims.filter((claim) => claim.support !== 'SUPPORTED').length;
  const lines = [
    `You are continuing run ${capsule.run_id}.`,
    `Start from this capsule, not from a transcript or a summary: continuation.json (capsule_ref ${capsule.capsule_ref}).`,
    `It was folded from the run's hash-chained ledger by the supervisor path — the previous agent did not write it.`,
    `${capsule.settled.length} item(s) are settled and need no rework. ${capsule.open.length} item(s) are open.`
  ];
  if (unsupported > 0) {
    lines.push(`${unsupported} claim(s) from the previous window have no witnessed support in that run — treat them as unverified until you check them yourself.`);
  }
  if (capsule.inherits) {
    lines.push(`This run itself continued from capsule ${capsule.inherits.capsule_ref}; the chain is verifiable with verify-lineage.`);
  }
  lines.push(`To open the next window as a verified continuation of this one, call begin_run with continues_from set to ${capsule.capsule_ref}.`);
  return lines.join(' ');
}

function renderEntries(lines, title, entries, emptyText) {
  lines.push(`## ${title}`, '');
  if (!entries.length) {
    lines.push(`- ${emptyText}`, '');
    return;
  }
  for (const item of entries) {
    lines.push(item.ref ? `- ${item.statement} _(${item.ref})_` : `- ${item.statement}`);
  }
  lines.push('');
}

export function renderHandoffMarkdown(capsule) {
  const lines = [
    '# HANDOFF — verified continuation for the next window',
    '',
    'This handoff was assembled from the run\'s hash-chained ledger, recorded during the run by the',
    'supervisor hook path. The agent did not write its own report card.',
    '',
    `- Run: \`${capsule.run_id}\``,
    `- Mode: \`${capsule.mode}\``,
    `- Status: \`${capsule.status}\``,
    `- Capsule ref: \`${capsule.capsule_ref}\``,
    `- Carry-forward state hash: \`${capsule.state_hash}\``,
    `- Continues from: ${capsule.inherits ? `\`${capsule.inherits.capsule_ref}\`` : '_no prior capsule declared_'}`,
    '',
    '## Paste this into the next window',
    '',
    '```text',
    buildHandoffPrompt(capsule),
    '```',
    '',
    '## Objective',
    '',
    `- ${capsule.objective || '_none recorded_'} _(origin: ${capsule.objective_origin})_`,
    ''
  ];

  renderEntries(lines, 'Settled — witnessed, needs no rework', capsule.settled, 'Nothing was observed as settled in this run.');
  renderEntries(lines, 'Open — not observed closed', capsule.open, 'No open structural conditions were observed.');
  renderEntries(lines, 'Next — the action that would close each open item', capsule.next, 'No next actions were derived.');

  lines.push('## Claims checked against the record', '');
  if (!capsule.claims.length) {
    lines.push('- No builder claims were recorded in this run.', '');
  } else {
    lines.push('| Support | Claim | Evidence |', '| --- | --- | --- |');
    for (const claim of capsule.claims) {
      const evidence = claim.evidence_refs.length ? claim.evidence_refs.join('<br>') : '_none cited_';
      lines.push(`| ${SUPPORT_MARK[claim.support] || claim.support} | ${claim.statement} | ${evidence} |`);
    }
    lines.push('');
  }

  const witnessed = capsule.witnessed;
  lines.push(
    '## What was witnessed',
    '',
    `- Ledger events: ${witnessed.event_count} (tip \`${witnessed.ledger_tip}\`)`,
    `- Tool attempts observed: ${witnessed.tool_attempts_observed}; tool returns observed: ${witnessed.tool_returns_observed}`,
    `- Children started: ${witnessed.children_started}; child receipts sealed: ${witnessed.child_receipts_sealed}; retrieved: ${witnessed.child_receipts_retrieved}`,
    `- PR snapshots: ${witnessed.pr_snapshots_observed}; evaluations: ${witnessed.evaluations_observed}`,
    '',
    '### Evidence origins',
    ''
  );
  const origins = Object.entries(witnessed.origin_counts);
  if (!origins.length) lines.push('- None recorded.');
  for (const [origin, count] of origins) lines.push(`- \`${origin}\`: ${count}`);
  lines.push('');

  lines.push('## Limitations', '');
  for (const limitation of capsule.limitations) lines.push(`- ${limitation}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}
