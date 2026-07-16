import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function isolatedData(t) {
  const directory = mkdtempSync(join(tmpdir(), 'lyhna-adapter-test-'));
  process.env.LYHNA_CODEX_DATA = directory;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    delete process.env.LYHNA_CODEX_DATA;
  });
  return directory;
}

export const stableSnapshot = {
  id: 'pr_fixture',
  repository: 'Lyhna-ai/example',
  pr_number: 7,
  base_sha: 'b'.repeat(40),
  head_before: 'a'.repeat(40),
  head_after: 'a'.repeat(40),
  status: 'CONSISTENT',
  files: [{ path: 'src/example.mjs', additions: 2, deletions: 1, status: 'modified' }],
  checks: [{ name: 'test', state: 'SUCCESS', workflow: 'CI' }],
  reviews: [],
  review_comments: [],
  issue_comments: [],
  failures: []
};
