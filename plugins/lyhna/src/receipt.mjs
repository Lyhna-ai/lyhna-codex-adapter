import { canonicalJson, sha256 } from './util.mjs';

const EVALUATION_TRIGGERS = new Set(['initial', 'post_fix_reeval', 'gate_audit', 're_examination']);

// Deterministic codepoint ordering for every sort that feeds a hashed render.
// Locale-aware collation is environment-dependent and must never influence a hash.
function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function eventLabel(event) {
  if (event.payload?.support) return event.payload.support;
  if (event.type === 'builder_claim') return 'builder assertion';
  if (event.type === 'evaluation_finding') return 'evaluator finding';
  return event.type.replaceAll('_', ' ');
}

function normalizeTrigger(value) {
  return EVALUATION_TRIGGERS.has(value) ? value : 'unspecified';
}

// B-1: derived at seal time from the sealed state so it can never contradict a later read event.
function buildSeal(state, events) {
  const sealed = Boolean(state.sealed);
  const childRetrieval = Object.values(state.child_receipts || {})
    .map((child) => ({ id: child.id, role: child.role, status: child.status, retrieved: Boolean(child.retrieved) }))
    .sort((a, b) => codepointCompare(a.id, b.id));
  return {
    status: sealed ? 'SEALED' : 'OPEN',
    seal_anchor_hash: sealed ? `sha256:${sha256(canonicalJson(state))}` : null,
    ledger_tip_hash: state.ledger_tip ? `sha256:${state.ledger_tip}` : (events.at(-1)?.event_hash ? `sha256:${events.at(-1).event_hash}` : null),
    event_count: state.ledger_count ?? events.length,
    evidence_order: 'Evidence is ordered strictly by ledger sequence (seq); closeout order can be reconstructed from these numbers alone.',
    child_retrieval_at_closeout: childRetrieval,
    verification: sealed
      ? 'Local verification proves hash-chain consistency of this ledger and its sealed anchor. It does not prove adversary-resistant custody of the local data directory against an actor with unrestricted filesystem access.'
      : 'This run is not sealed; no closeout anchor has been written yet.'
  };
}

// B-4: structural coverage boundary — no wall-clock claims.
function buildCoverage(state, events) {
  const runBegun = events.find((event) => event.type === 'run_begun');
  const invocation = runBegun?.payload?.invocation || null;
  const invocationStatement = state.objective_origin === 'runtime_hook' && invocation
    ? `Hook-observed invocation: matched form "${invocation.matched_form}" at prompt offset ${invocation.mention_offset}.`
    : 'No hook-observed invocation preceded this run; the objective is agent-reported.';
  const childCount = Object.keys(state.children || {}).length;
  const childLifecycle = childCount === 0
    ? 'No ordinary delegated-child lifecycle was observed during this run.'
    : 'Delegated-child lifecycle events were observed; see the child receipts section.';
  const openPredecessors = state.open_predecessors || [];
  const witnessingBoundary = (openPredecessors.length > 0 || state.objective_origin !== 'runtime_hook')
    ? "Witnessing began at this run's first event; earlier session activity was not observed."
    : 'Witnessing began at the hook-observed invocation in this run; any session activity before that invocation was not observed.';
  return {
    configured_hooks: state.configured_hooks,
    caveat: 'Absence means not observed within configured coverage; it does not prove an action did not occur elsewhere.',
    invocation: invocationStatement,
    child_lifecycle: childLifecycle,
    witnessing_boundary: witnessingBoundary
  };
}

// CZ-12: observational open-run visibility. Never an intent judgment.
function buildOpenPredecessors(state) {
  return (state.open_predecessors || [])
    .map((predecessor) => ({
      run_id: predecessor.run_id,
      last_event_seq: predecessor.last_event_seq,
      statement: `A prior run in this session was OPEN with no close request when this run began (run ${predecessor.run_id}, last event seq ${predecessor.last_event_seq}).`
    }))
    .sort((a, b) => codepointCompare(a.run_id, b.run_id));
}

// B-2 + B-3: per-PR head chains with a semantic ladder rendered at each head.
function buildHeadChains(state, events) {
  const snapshotSeq = {};
  const refreshBySnapshot = {};
  const evalEventMaxSeq = {};
  for (const event of events) {
    if (event.type === 'pr_snapshot') snapshotSeq[event.payload.id] = event.seq;
    if (event.type === 'pr_refreshed') {
      (refreshBySnapshot[event.payload.snapshot_id] ||= []).push({
        seq: event.seq,
        observed_head: event.payload.observed_head,
        status: event.payload.status
      });
    }
    if (event.type === 'evaluation_requested') {
      const id = event.payload.snapshot_id;
      evalEventMaxSeq[id] = Math.max(evalEventMaxSeq[id] || 0, event.seq);
    }
    if (event.type === 'evaluation_finding') {
      const evaluation = state.evaluations?.[event.payload.evaluation_request_id];
      if (evaluation) evalEventMaxSeq[evaluation.snapshot_id] = Math.max(evalEventMaxSeq[evaluation.snapshot_id] || 0, event.seq);
    }
  }

  const evaluationsBySnapshot = {};
  for (const evaluation of Object.values(state.evaluations || {})) {
    (evaluationsBySnapshot[evaluation.snapshot_id] ||= []).push(evaluation);
  }

  const groups = new Map();
  for (const snapshot of Object.values(state.pr_snapshots || {})) {
    const key = `${snapshot.repository}\u0000${snapshot.pr_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snapshot);
  }

  const chains = [];
  for (const [key, snapshots] of groups) {
    const [repository, prNumber] = key.split('\u0000');
    const ordered = [...snapshots].sort((a, b) => (snapshotSeq[a.id] ?? 0) - (snapshotSeq[b.id] ?? 0) || codepointCompare(a.id, b.id));

    // Refreshes recorded for any snapshot in this PR group, in ledger-seq order, so we can tell
    // whether the head diverged and returned between two same-SHA snapshots (a force-push away and back).
    const groupRefreshes = snapshots
      .flatMap((snapshot) => refreshBySnapshot[snapshot.id] || [])
      .sort((a, b) => a.seq - b.seq);

    // B-2 / Fix 4: chain entries are keyed by head progression, not snapshot count.
    // Consecutive snapshots at the identical head merge into ONE entry so we never assert
    // a head progression that did not occur; "later"/"superseded" language may only appear
    // when the head actually differs between entries.
    // Fix B: merge same-SHA snapshots ONLY when nothing recorded shows the head left and returned —
    // split when an earlier same-SHA snapshot went STALE, or when an intervening refresh observed a
    // different head between the two snapshots' seqs. Otherwise a force-push away-and-back would fold
    // the STALE observation into the current entry and erase the one CURRENT head.
    const headEntries = [];
    for (const snapshot of ordered) {
      const head = snapshot.head_after || snapshot.head_before;
      const last = headEntries.at(-1);
      const lastSeq = last ? Math.max(...last.snapshots.map((prior) => snapshotSeq[prior.id] ?? 0)) : 0;
      const currentSeq = snapshotSeq[snapshot.id] ?? 0;
      const headDiverged = Boolean(last) && (
        last.snapshots.some((prior) => prior.status === 'STALE')
        || groupRefreshes.some((refresh) => refresh.seq > lastSeq && refresh.seq < currentSeq && refresh.observed_head !== head)
      );
      if (last && last.head === head && !headDiverged) last.snapshots.push(snapshot);
      else headEntries.push({ head, snapshots: [snapshot] });
    }

    const built = headEntries.map((entry, index) => {
      const isFinal = index === headEntries.length - 1;
      const statuses = entry.snapshots.map((snapshot) => snapshot.status);
      let chainLabel;
      if (statuses.includes('INCONSISTENT_SNAPSHOT')) chainLabel = 'INCONSISTENT_SNAPSHOT';
      else if (statuses.includes('STALE')) chainLabel = 'STALE';
      else if (!isFinal) chainLabel = 'SUPERSEDED';
      else {
        const lastEval = Math.max(0, ...entry.snapshots.map((snapshot) => evalEventMaxSeq[snapshot.id] || 0));
        const refreshed = entry.snapshots.some((snapshot) => (refreshBySnapshot[snapshot.id] || [])
          .some((refresh) => refresh.seq > lastEval && refresh.status === 'CURRENT_AT_REFRESH'));
        chainLabel = refreshed ? 'CURRENT' : 'NOT_REFRESHED';
      }

      // Aggregate the merged entry's evaluations; each keeps its own B-5 trigger so
      // same-head evaluations stay distinguishable within the single entry.
      const entryEvaluations = entry.snapshots
        .flatMap((snapshot) => evaluationsBySnapshot[snapshot.id] || [])
        .slice()
        .sort((a, b) => codepointCompare(a.id, b.id));

      // B-3 rung 1: workflow checks, named strictly as check-runs.
      const workflowChecks = entry.snapshots.flatMap((snapshot) => (snapshot.checks || []).map((check) => ({
        check_run: check.name,
        state: check.state,
        statement: `check-run named "${check.name}": state ${check.state}`
      })));

      // B-3 rung 2: independent evaluation status and retrieval of the finding statement (by hash).
      const independentEvaluation = entryEvaluations.map((evaluation) => {
        const statementRefs = (evaluation.findings || [])
          .map((finding) => finding.statement_ref?.sha256)
          .filter(Boolean);
        const statementRef = statementRefs.at(-1) || null;
        const retrieved = Boolean(evaluation.child_receipt_retrieved);
        return {
          evaluation_id: evaluation.id,
          status: evaluation.status,
          trigger: normalizeTrigger(evaluation.trigger),
          finding_statement_retrieved: retrieved,
          finding_statement_ref: statementRef ? `sha256:${statementRef}` : null,
          statement: `independent evaluation ${evaluation.id} (trigger: ${normalizeTrigger(evaluation.trigger)}): status ${evaluation.status}; evaluator finding statement ${retrieved ? 'retrieved' : 'not retrieved'}${statementRef ? ` (sha256:${statementRef})` : ''}`
        };
      });

      return {
        snapshot_ids: entry.snapshots.map((snapshot) => snapshot.id).sort(codepointCompare),
        head: entry.head,
        seq: Math.min(...entry.snapshots.map((snapshot) => snapshotSeq[snapshot.id] ?? 0)),
        capture_status: entry.snapshots.at(-1).status,
        chain_label: chainLabel,
        checks_observed: entry.snapshots.reduce((total, snapshot) => total + (snapshot.checks?.length ?? 0), 0),
        reviews_observed: entry.snapshots.reduce((total, snapshot) => total + (snapshot.reviews?.length ?? 0), 0),
        workflow_checks: workflowChecks,
        independent_evaluation: independentEvaluation,
        evaluations: entryEvaluations
      };
    });

    const heads = built.map((entry, index) => {
      // Fix 1 (B-3 rung 3): there is NO structural clean-evaluation signal in the schema — RECORDED
      // attests checkout integrity only, not that a finding was addressed. This rung is therefore
      // constitutionally constant ("Not established by this record.") until such a signal exists.
      // Later evaluations at subsequent heads are surfaced separately as plain observations only.
      const laterReevaluations = built.slice(index + 1).flatMap((later) => later.evaluations.map((evaluation) => ({
        head: later.head,
        evaluation_id: evaluation.id,
        trigger: normalizeTrigger(evaluation.trigger),
        // A same-SHA later entry (the head left and returned to this exact head) is not "a later head";
        // describe it as a later observation of the same head, keeping the strictly observational voice.
        statement: later.head === entry.head
          ? `A later observation of head ${later.head} recorded an independent evaluation (evaluation ${evaluation.id}, trigger: ${normalizeTrigger(evaluation.trigger)}).`
          : `A later evaluation at head ${later.head} was recorded (evaluation ${evaluation.id}, trigger: ${normalizeTrigger(evaluation.trigger)}).`
      })));

      return {
        snapshot_ids: entry.snapshot_ids,
        head: entry.head,
        seq: entry.seq,
        capture_status: entry.capture_status,
        chain_label: entry.chain_label,
        checks_observed: entry.checks_observed,
        reviews_observed: entry.reviews_observed,
        ladder: {
          workflow_checks: entry.workflow_checks,
          independent_evaluation: entry.independent_evaluation,
          later_reevaluations: laterReevaluations,
          findings_addressed: 'Not established by this record.',
          acceptance: 'Not a rung this receipt can assert — acceptance is the operator\'s decision.'
        }
      };
    });
    chains.push({ repository, pr_number: Number(prNumber), heads });
  }
  return chains.sort((a, b) => codepointCompare(`${a.repository}#${a.pr_number}`, `${b.repository}#${b.pr_number}`));
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
  })).sort((a, b) => codepointCompare(a.id, b.id));

  const evaluations = Object.values(state.evaluations || {}).map((evaluation) => ({
    id: evaluation.id,
    snapshot_id: evaluation.snapshot_id,
    status: evaluation.status,
    trigger: normalizeTrigger(evaluation.trigger),
    expected_head: evaluation.expected_head,
    checkout_head_before: evaluation.checkout_head_before || null,
    checkout_head_after: evaluation.checkout_head_after || null,
    checkout_clean_before: evaluation.checkout_clean_before ?? null,
    checkout_clean_after: evaluation.checkout_clean_after ?? null,
    checkout_detached_before: evaluation.checkout_detached_before ?? null,
    checkout_detached_after: evaluation.checkout_detached_after ?? null,
    child_receipt_id: evaluation.child_receipt_id || null,
    child_receipt_retrieved: Boolean(evaluation.child_receipt_retrieved)
  })).sort((a, b) => codepointCompare(a.id, b.id));

  const receipt = {
    schema: 'lyhna.codex.adapter-receipt.v0',
    run_id: state.id,
    mode: state.mode,
    status: state.sealed ? 'SEALED' : 'OPEN',
    build_record: state.mode === 'pr_only' ? 'unavailable' : 'witnessed_within_configured_coverage',
    objective: state.objective,
    objective_origin: state.objective_origin,
    seal: buildSeal(state, events),
    open_predecessors: buildOpenPredecessors(state),
    coverage: buildCoverage(state, events),
    evidence: events.map((event) => ({
      seq: event.seq,
      ref: `sha256:${event.event_hash}`,
      type: event.type,
      origin: event.origin,
      label: eventLabel(event),
      payload: event.payload
    })),
    pr_snapshots: snapshots,
    pr_head_chains: buildHeadChains(state, events),
    evaluations,
    child_receipts: Object.values(state.child_receipts || {}).map((item) => ({
      id: item.id,
      role: item.role,
      status: item.status,
      retrieved: Boolean(item.retrieved)
    })).sort((a, b) => codepointCompare(a.id, b.id)),
    limitations: [
      'This receipt records supported observations and attributed reports; it is not an approval or correctness judgment.',
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
    '## Seal',
    '',
    `- Seal status: **${receipt.seal.status}**`,
    `- Seal-anchor hash: \`${receipt.seal.seal_anchor_hash ?? 'n/a'}\``,
    `- Ledger tip hash: \`${receipt.seal.ledger_tip_hash ?? 'n/a'}\``,
    `- Event count: ${receipt.seal.event_count}`,
    '',
    receipt.seal.evidence_order,
    ''
  ];
  if (receipt.seal.child_retrieval_at_closeout.length) {
    lines.push('Per-child retrieval status as of closeout:');
    for (const child of receipt.seal.child_retrieval_at_closeout) {
      lines.push(`- \`${child.id}\` (${child.role}): **${child.status}**; retrieved: **${child.retrieved ? 'yes' : 'no'}**`);
    }
  } else {
    lines.push('Per-child retrieval status as of closeout: none recorded.');
  }
  lines.push('', `_${receipt.seal.verification}_`, '', '## Prior open runs in this session', '');
  if (!receipt.open_predecessors.length) lines.push('- None observed when this run began.');
  for (const predecessor of receipt.open_predecessors) lines.push(`- ${predecessor.statement}`);
  lines.push(
    '',
    '## Coverage',
    '',
    receipt.coverage.caveat,
    '',
    `- Invocation: ${receipt.coverage.invocation}`,
    `- Delegated children: ${receipt.coverage.child_lifecycle}`,
    `- Witnessing boundary: ${receipt.coverage.witnessing_boundary}`,
    '',
    '## Evidence (ledger order)',
    ''
  );
  if (!receipt.evidence.length) lines.push('- No supported evidence recorded.');
  for (const event of receipt.evidence) {
    lines.push(`- ${event.seq}. \`${event.origin}\` — ${event.label}`);
  }
  lines.push('', '## Pull request head chains', '');
  if (!receipt.pr_head_chains.length) lines.push('- None recorded.');
  for (const chain of receipt.pr_head_chains) {
    lines.push(`### ${chain.repository} PR #${chain.pr_number}`, '');
    for (const head of chain.heads) {
      lines.push(`- Head \`${head.head}\` (captured ${head.capture_status}): **${head.chain_label}**`);
      lines.push(`  - Workflow checks: ${head.ladder.workflow_checks.length ? head.ladder.workflow_checks.map((check) => check.statement).join('; ') : 'No workflow check-runs were observed at this head.'}`);
      lines.push(`  - Independent evaluation: ${head.ladder.independent_evaluation.length ? head.ladder.independent_evaluation.map((item) => item.statement).join('; ') : 'No independent evaluation was recorded at this head.'}`);
      if (head.ladder.later_reevaluations.length) {
        lines.push(`  - Later re-evaluations: ${head.ladder.later_reevaluations.map((item) => item.statement).join('; ')}`);
      }
      lines.push(`  - Findings addressed: ${head.ladder.findings_addressed}`);
      lines.push(`  - Acceptance: ${head.ladder.acceptance}`);
    }
    lines.push('');
  }
  if (receipt.pr_head_chains.length) lines.pop();
  lines.push('', '## Independent evaluations', '');
  if (!receipt.evaluations.length) lines.push('- None recorded.');
  for (const evaluation of receipt.evaluations) {
    lines.push(`- \`${evaluation.id}\` at \`${evaluation.expected_head}\` (trigger: \`${evaluation.trigger}\`): **${evaluation.status}**; child receipt retrieved: **${evaluation.child_receipt_retrieved ? 'yes' : 'no'}**`);
  }
  lines.push('', '## Child receipts', '');
  if (!receipt.child_receipts.length) lines.push('- None recorded.');
  for (const child of receipt.child_receipts) {
    lines.push(`- \`${child.id}\` (${child.role}): **${child.status}**; retrieved: **${child.retrieved ? 'yes' : 'no'}**`);
  }
  lines.push('', '## Limitations', '');
  for (const limitation of receipt.limitations) lines.push(`- ${limitation}`);
  return `${lines.join('\n')}\n`;
}
