import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('portable plugin package points to existing skill, hook, and MCP entrypoints', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const skill = readFileSync(join(root, 'skills', 'lyhna', 'SKILL.md'), 'utf8');
  assert.equal(manifest.name, 'lyhna-codex-adapter');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(mcp.mcpServers.lyhna.env_vars, ['LYHNA_CODEX_DATA']);
  assert.equal(mcp.mcpServers.lyhna.cwd, '.');
  assert.equal(mcp.mcpServers.lyhna.default_tools_approval_mode, 'approve');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
    assert(Array.isArray(hooks.hooks[event]), `${event} hook missing`);
  }
  assert.match(skill, /^---\r?\nname: lyhna\r?\n/m);
});
