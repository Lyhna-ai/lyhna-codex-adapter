import { join } from 'node:path';
import { dataRoot } from './util.mjs';
import { inspectCheckout, prepareEvaluatorCheckout, refreshPrHead, snapshotPr } from './github.mjs';
import {
  addPrSnapshot,
  beginEvaluation as beginEvaluationStore,
  beginRun,
  claimEvaluation,
  getCapability,
  listChildReceipts,
  markSnapshotRefreshed,
  readSealedReceipt,
  recordClaim,
  recordEvaluation as recordEvaluationStore,
  requestClose
} from './store.mjs';

function requireSnapshot(state, snapshotId) {
  const snapshot = state.pr_snapshots[snapshotId];
  if (!snapshot) throw Object.assign(new Error('SNAPSHOT_NOT_FOUND'), { code: 'SNAPSHOT_NOT_FOUND' });
  return snapshot;
}

export const toolDefinitions = [
  ['begin_run', 'Start an explicitly requested Lyhna run. Use mode "full" whenever the request asks to build, change, fix, continue, or delegate work; use "pr_only" only for a solely retrospective examination of an existing PR; when ambiguous, choose "full".', ['session_capability', 'mode']],
  ['record_claim', 'Record a builder assertion with optional evidence references.', ['session_capability', 'statement']],
  ['snapshot_pr', 'Capture sanitized GitHub metadata at an exact observed PR head.', ['session_capability', 'repository', 'pr_number']],
  ['begin_evaluation', 'Create an evaluator request and detached exact-head checkout.', ['session_capability', 'pr_snapshot_id', 'source_cwd']],
  ['claim_evaluation', 'Bind a hook-issued child capability to an evaluator request.', ['child_capability', 'evaluation_request_id']],
  ['record_evaluation', 'Record an attributed evaluator finding and checkout integrity observations.', ['child_capability', 'evaluation_request_id', 'finding', 'checkout_head_before', 'checkout_clean_before', 'checkout_detached_before']],
  ['refresh_pr', 'Explicitly recheck whether a PR snapshot head is current.', ['session_capability', 'pr_snapshot_id']],
  ['list_child_receipts', 'List sealed child receipts for the active run.', ['session_capability']],
  ['read_sealed_receipt', 'Retrieve and mark a child receipt as read by the parent.', ['session_capability', 'receipt_id']],
  ['request_close', 'Request parent sealing at the next Stop hook.', ['session_capability', 'reason']]
].map(([name, description, required]) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      session_capability: { type: 'string' },
      child_capability: { type: 'string' },
      mode: { type: 'string', enum: ['full', 'pr_only'], description: '"full" for any request to build, change, fix, continue, or delegate work; "pr_only" only for a solely retrospective PR examination; prefer "full" when ambiguous.' },
      objective: { type: 'string' },
      statement: { type: 'string' },
      evidence_refs: { type: 'array', items: { type: 'string' } },
      repository: { type: 'string' },
      pr_number: { type: 'integer', minimum: 1 },
      pr_snapshot_id: { type: 'string' },
      source_cwd: { type: 'string' },
      evaluation_request_id: { type: 'string' },
      finding: { type: 'string' },
      checkout_head_before: { type: 'string' },
      checkout_head_after: { type: 'string' },
      checkout_clean_before: { type: 'boolean' },
      checkout_clean_after: { type: 'boolean' },
      checkout_detached_before: { type: 'boolean' },
      checkout_detached_after: { type: 'boolean' },
      receipt_id: { type: 'string' },
      reason: { type: 'string' }
    },
    required
  }
}));

export function createService({ githubRunner } = {}) {
  return {
    async call(name, args = {}) {
      switch (name) {
        case 'begin_run': {
          const state = beginRun(args.session_capability, { mode: args.mode, objective: args.objective });
          return { run_id: state.id, mode: state.mode, objective_origin: state.objective_origin, status: 'OPEN' };
        }
        case 'record_claim':
          return recordClaim(args.session_capability, args.statement, args.evidence_refs || []);
        case 'snapshot_pr': {
          const snapshot = snapshotPr({ repository: args.repository, prNumber: args.pr_number, runner: githubRunner });
          return addPrSnapshot(args.session_capability, snapshot);
        }
        case 'begin_evaluation': {
          const active = (await import('./store.mjs')).activeRunFor(args.session_capability);
          const state = (await import('./store.mjs')).getRunForTesting(active).state;
          const snapshot = requireSnapshot(state, args.pr_snapshot_id);
          const evaluationPath = join(dataRoot(), 'evaluations', `${active}-${args.pr_snapshot_id}`, 'worktree');
          const existing = Object.values(state.evaluations).find((item) => item.snapshot_id === args.pr_snapshot_id && !['STALE', 'INVALID'].includes(item.status));
          if (existing) return { ...existing, checkout_path: evaluationPath };
          let checkout = {};
          if (snapshot?.status === 'CONSISTENT') {
            try {
              checkout = prepareEvaluatorCheckout({ sourceCwd: args.source_cwd, destination: evaluationPath, head: snapshot.head_after, repository: snapshot.repository, runner: githubRunner });
            } catch (error) {
              const failure = new Error(`CHECKOUT_PREPARATION_FAILED: ${error.message}`);
              failure.code = 'CHECKOUT_PREPARATION_FAILED';
              throw failure;
            }
          }
          const stored = beginEvaluationStore(args.session_capability, args.pr_snapshot_id, checkout);
          return { ...stored, checkout_path: checkout.path };
        }
        case 'claim_evaluation':
          return claimEvaluation(args.child_capability, args.evaluation_request_id);
        case 'record_evaluation': {
          const child = getCapability(args.child_capability);
          const active = child.parent_run_id;
          const state = (await import('./store.mjs')).getRunForTesting(active).state;
          const evaluation = state.evaluations[args.evaluation_request_id];
          let observed = {
            head_before: args.checkout_head_before,
            head_after: args.checkout_head_after,
            clean_before: args.checkout_clean_before,
            clean_after: args.checkout_clean_after,
            detached_before: args.checkout_detached_before,
            detached_after: args.checkout_detached_after
          };
          if (evaluation?.checkout_path_ref) {
            const evaluationPath = join(dataRoot(), 'evaluations', `${active}-${evaluation.snapshot_id}`, 'worktree');
            const live = inspectCheckout({ path: evaluationPath, runner: githubRunner });
            observed = {
              head_before: args.checkout_head_before,
              head_after: live.head,
              clean_before: args.checkout_clean_before,
              clean_after: live.clean,
              detached_before: args.checkout_detached_before,
              detached_after: live.detached
            };
          }
          return recordEvaluationStore(args.child_capability, args.evaluation_request_id, args.finding, args.evidence_refs || [], observed);
        }
        case 'refresh_pr': {
          const active = (await import('./store.mjs')).activeRunFor(args.session_capability);
          const state = (await import('./store.mjs')).getRunForTesting(active).state;
          const snapshot = requireSnapshot(state, args.pr_snapshot_id);
          const head = refreshPrHead({ repository: snapshot.repository, prNumber: snapshot.pr_number, runner: githubRunner });
          return markSnapshotRefreshed(args.session_capability, args.pr_snapshot_id, head);
        }
        case 'list_child_receipts':
          return listChildReceipts(args.session_capability);
        case 'read_sealed_receipt':
          return readSealedReceipt(args.session_capability, args.receipt_id);
        case 'request_close':
          return requestClose(args.session_capability, args.reason);
        default:
          throw Object.assign(new Error(`UNKNOWN_TOOL: ${name}`), { code: 'UNKNOWN_TOOL' });
      }
    }
  };
}
