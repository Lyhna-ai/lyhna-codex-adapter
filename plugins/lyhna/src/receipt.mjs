import { canonicalJson } from './util.mjs';

function eventLabel(event) {
  if (event.payload?.support) return event.payload.support;
  if (event.type === 'builder_claim') return 'builder assertion';
  if (event.type === 'evaluation_finding') return 'evaluator finding';
  return event.type.replaceAll('_', ' ');
}

export function buildReceipt(state, events) {
  const snapshots = Object.values(state.pr_snapshots || {}).map((snapshot) => ({
    id: snapshot.id,
    repository: snapshot.repository,
    pr_number: snapshot.pr_number,
    head_before: snapshot.head_before,
    head_after: snapshot.head_after,
    status: snapshot.status,
    current_head: snapshot.current_head || snapshot.head_after,
    files_observed: snapshot.files?.length ?? 0,
    checks_observed: snapshot.checks?.length ?? 0,
    reviews_observed: snapshot.reviews?.length ?? 0,
    review_comments_observed: snapshot.review_comments?.length ?? 0,
    issue_comments_observed: snapshot.issue_comments?.length ?? 0,
    failures: snapshot.failures || []
  })).sort((a, b) => a.id.localeCompare(b.id));

  const evaluations = Object.values(state.evaluations || {}).map((evaluation) => ({
    id: evaluation.id,
    snapshot_id: evaluation.snapshot_id,
    status: evaluation.status,
    expected_head: evaluation.expected_head,
    checkout_head_before: evaluation.checkout_head_before || null,
    checkout_head_after: evaluation.checkout_head_after || null,
    checkout_clean_before: evaluation.checkout_clean_before ?? null,
    checkout_clean_after: evaluation.checkout_clean_after ?? null,
    child_receipt_id: evaluation.child_receipt_id || null,
    child_receipt_retrieved: Boolean(evaluation.child_receipt_retrieved)
  })).sort((a, b) => a.id.localeCompare(b.id));

  const receipt = {
    schema: 'lyhna.codex.adapter-receipt.v0',
    run_id: state.id,
    mode: state.mode,
    status: state.sealed ? 'SEALED' : 'OPEN',
    build_record: state.mode === 'pr_only' ? 'unavailable' : 'witnessed_within_configured_coverage',
    objective: state.objective,
    objective_origin: state.objective_origin,
    coverage: {
      configured_hooks: state.configured_hooks,
      caveat: 'Absence means not observed within configured coverage; it does not prove an action did not occur elsewhere.'
    },
    evidence: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      origin: event.origin,
      label: eventLabel(event),
      payload: event.payload
    })),
    pr_snapshots: snapshots,
    evaluations,
    child_receipts: Object.values(state.child_receipts || {}).map((item) => ({
      id: item.id,
      role: item.role,
      status: item.status,
      retrieved: Boolean(item.retrieved)
    })).sort((a, b) => a.id.localeCompare(b.id)),
    limitations: [
      'This receipt records supported observations and attributed reports; it is not an approval or correctness judgment.',
      'Local hash-chain and seal checks detect some mutation or deletion but are not adversary-resistant custody.',
      ...(state.mode === 'pr_only' ? ['No witnessed build record was available for this retrospective PR examination.'] : [])
    ]
  };
  return receipt;
}

export function renderReceiptJson(state, events) {
  return canonicalJson(buildReceipt(state, events), true);
}

export function renderReceiptMarkdown(state, events) {
  const receipt = buildReceipt(state, events);
  const lines = [
    '# Lyhna Codex Run Receipt',
    '',
    `- Run: \`${receipt.run_id}\``,
    `- Status: **${receipt.status}**`,
    `- Mode: \`${receipt.mode}\``,
    `- Build record: **${receipt.build_record}**`,
    `- Objective origin: \`${receipt.objective_origin}\``,
    '',
    '## Coverage',
    '',
    receipt.coverage.caveat,
    '',
    '## Evidence',
    ''
  ];
  if (!receipt.evidence.length) lines.push('- No supported evidence recorded.');
  for (const event of receipt.evidence) {
    lines.push(`- ${event.seq}. \`${event.origin}\` — ${event.label}`);
  }
  lines.push('', '## Pull request snapshots', '');
  if (!receipt.pr_snapshots.length) lines.push('- None recorded.');
  for (const snapshot of receipt.pr_snapshots) {
    lines.push(`- PR #${snapshot.pr_number} at \`${snapshot.head_after || snapshot.head_before}\`: **${snapshot.status}**`);
  }
  lines.push('', '## Independent evaluations', '');
  if (!receipt.evaluations.length) lines.push('- None recorded.');
  for (const evaluation of receipt.evaluations) {
    lines.push(`- \`${evaluation.id}\` at \`${evaluation.expected_head}\`: **${evaluation.status}**; child receipt retrieved: **${evaluation.child_receipt_retrieved ? 'yes' : 'no'}**`);
  }
  lines.push('', '## Limitations', '');
  for (const limitation of receipt.limitations) lines.push(`- ${limitation}`);
  return `${lines.join('\n')}\n`;
}
