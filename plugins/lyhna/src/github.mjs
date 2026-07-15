import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boundedText, reference } from './redact.mjs';
import { assert } from './util.mjs';

export function processRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(`${command} failed with exit ${result.status}: ${boundedText(result.stderr, 300)}`);
    error.code = 'PROCESS_FAILED';
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim();
}

function ghJson(runner, args) {
  const parsed = JSON.parse(runner('gh', args));
  return Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed.flat() : parsed;
}

function safeFiles(items = []) {
  return items.map((item) => ({
    path: boundedText(item.path || item.filename, 260),
    additions: Number(item.additions || 0),
    deletions: Number(item.deletions || 0),
    status: boundedText(item.status || item.changeType || '', 40) || null
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function safeChecks(items = []) {
  return items.map((item) => ({
    name: boundedText(item.name || item.context || '', 160),
    state: boundedText(item.state || item.conclusion || item.status || '', 60),
    workflow: boundedText(item.workflowName || '', 120) || null
  })).sort((a, b) => `${a.name}:${a.workflow}`.localeCompare(`${b.name}:${b.workflow}`));
}

function safeReviews(items = []) {
  return items.map((item) => ({
    author: boundedText(item.author?.login || item.user?.login || '', 100) || null,
    state: boundedText(item.state || '', 60),
    commit_id: boundedText(item.commit?.oid || item.commit_id || '', 64) || null,
    body_ref: item.body ? reference(item.body) : null
  })).sort((a, b) => `${a.author}:${a.state}:${a.commit_id}`.localeCompare(`${b.author}:${b.state}:${b.commit_id}`));
}

function safeComments(items = []) {
  return items.map((item) => ({
    id: Number(item.id || 0),
    author: boundedText(item.author?.login || item.user?.login || '', 100) || null,
    path: boundedText(item.path || '', 260) || null,
    commit_id: boundedText(item.commit_id || item.original_commit_id || '', 64) || null,
    body_ref: item.body ? reference(item.body) : null
  })).sort((a, b) => a.id - b.id);
}

export function snapshotPr({ repository, prNumber, runner = processRunner }) {
  assert(/^[^\s/]+\/[^\s/]+$/.test(repository), 'INVALID_REPOSITORY');
  assert(Number.isInteger(Number(prNumber)) && Number(prNumber) > 0, 'INVALID_PR_NUMBER');
  const fields = 'number,url,title,state,isDraft,baseRefOid,headRefOid,files,statusCheckRollup,reviews';
  const before = ghJson(runner, ['pr', 'view', String(prNumber), '--repo', repository, '--json', fields]);
  const failures = [];
  let reviewComments = [];
  let issueComments = [];
  try {
    reviewComments = ghJson(runner, ['api', `repos/${repository}/pulls/${prNumber}/comments`, '--paginate', '--slurp']);
  } catch (error) {
    failures.push({ object: 'review_comments', error: boundedText(error.message, 200) });
  }
  try {
    issueComments = ghJson(runner, ['api', `repos/${repository}/issues/${prNumber}/comments`, '--paginate', '--slurp']);
  } catch (error) {
    failures.push({ object: 'issue_comments', error: boundedText(error.message, 200) });
  }
  const after = ghJson(runner, ['pr', 'view', String(prNumber), '--repo', repository, '--json', 'headRefOid']);
  const consistent = before.headRefOid && before.headRefOid === after.headRefOid;
  return {
    repository,
    pr_number: Number(prNumber),
    url: boundedText(before.url, 300),
    title: boundedText(before.title, 200),
    state: boundedText(before.state, 40),
    is_draft: Boolean(before.isDraft),
    base_sha: boundedText(before.baseRefOid, 64),
    head_before: boundedText(before.headRefOid, 64),
    head_after: boundedText(after.headRefOid, 64),
    status: consistent ? 'CONSISTENT' : 'INCONSISTENT_SNAPSHOT',
    files: safeFiles(before.files),
    checks: safeChecks(before.statusCheckRollup),
    reviews: safeReviews(before.reviews),
    review_comments: safeComments(reviewComments),
    issue_comments: safeComments(issueComments),
    failures
  };
}

export function refreshPrHead({ repository, prNumber, runner = processRunner }) {
  const value = ghJson(runner, ['pr', 'view', String(prNumber), '--repo', repository, '--json', 'headRefOid']);
  return boundedText(value.headRefOid, 64);
}

function git(runner, cwd, args) {
  return runner('git', args, { cwd });
}

export function inspectCheckout({ path, runner = processRunner }) {
  const head = git(runner, path, ['rev-parse', 'HEAD']);
  const dirty = git(runner, path, ['status', '--porcelain', '--untracked-files=no']);
  return { head: head.trim(), clean: dirty.trim() === '' };
}

function repositoryFromRemote(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  const match = text.match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1]?.replace(/\.git$/i, '').toLowerCase() || null;
}

export function prepareEvaluatorCheckout({ sourceCwd, destination, head, repository, runner = processRunner }) {
  assert(sourceCwd, 'MISSING_SOURCE_CHECKOUT');
  assert(head, 'MISSING_HEAD');
  assert(repository, 'MISSING_REPOSITORY');
  const origin = git(runner, sourceCwd, ['remote', 'get-url', 'origin']);
  assert(repositoryFromRemote(origin) === String(repository).toLowerCase(), 'SOURCE_REPOSITORY_MISMATCH');
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    const existing = inspectCheckout({ path: destination, runner });
    assert(existing.head === head && existing.clean, 'EXISTING_CHECKOUT_MISMATCH');
    return { path: join(destination), ...existing };
  }
  try {
    git(runner, sourceCwd, ['cat-file', '-e', `${head}^{commit}`]);
  } catch {
    git(runner, sourceCwd, ['fetch', 'origin', head]);
    git(runner, sourceCwd, ['cat-file', '-e', `${head}^{commit}`]);
  }
  git(runner, sourceCwd, ['worktree', 'add', '--detach', destination, head]);
  const inspected = inspectCheckout({ path: destination, runner });
  assert(inspected.head === head, 'CHECKOUT_HEAD_MISMATCH');
  return { path: join(destination), ...inspected };
}
