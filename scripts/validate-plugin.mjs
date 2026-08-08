import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = resolve('plugins', 'lyhna');
const json = (path) => JSON.parse(readFileSync(join(plugin, path), 'utf8'));
const portableManifest = json('plugin.json');
const portableMcp = json('mcp.json');
const openaiManifest = json(join('.codex-plugin', 'plugin.json'));
const openaiMcp = json('.mcp.json');
const packageJson = json('package.json');
const openaiHooks = json(join('hooks', 'hooks.json'));
const extensionHooks = json(join('ai.lyhna.codex', 'hooks', 'hooks.json'));
const openaiHookBridge = readFileSync(join(plugin, 'hooks', 'capture.mjs'), 'utf8');
const marketplace = JSON.parse(readFileSync(resolve('.agents', 'plugins', 'marketplace.json'), 'utf8'));
const skill = readFileSync(join(plugin, 'skills', 'lyhna', 'SKILL.md'), 'utf8');

assert.deepEqual(
  Object.keys(portableManifest).sort(),
  ['$schema', 'author', 'description', 'homepage', 'keywords', 'name', 'repository', 'version'].sort()
);
assert.equal(portableManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(portableManifest.name, 'lyhna-codex-adapter');
assert.match(portableManifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(portableMcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.deepEqual(Object.keys(portableMcp), ['$schema', 'mcpServers']);
assert.deepEqual(Object.keys(portableMcp.mcpServers), ['lyhna']);
assert.deepEqual(portableMcp.mcpServers.lyhna, {
  type: 'stdio',
  command: 'node',
  args: ['${PLUGIN_ROOT}/src/mcp-server.mjs'],
  env: { LYHNA_CODEX_DATA: '${PLUGIN_DATA}' },
  cwd: '${PLUGIN_ROOT}'
});
assert.equal(openaiManifest.name, portableManifest.name);
assert.equal(openaiManifest.version, portableManifest.version);
assert.equal(openaiManifest.skills, './skills/');
assert.equal(openaiManifest.mcpServers, './.mcp.json');
assert.equal(openaiManifest.hooks, './hooks/hooks.json');
assert.deepEqual(Object.keys(openaiMcp), ['lyhna']);
assert.equal(openaiMcp.lyhna.command, 'node');
assert.deepEqual(openaiMcp.lyhna.args, ['./src/mcp-server.mjs']);
assert.deepEqual(openaiMcp.lyhna.env_vars, ['LYHNA_CODEX_DATA']);
assert.equal(openaiMcp.lyhna.cwd, '.');
assert.equal(openaiMcp.lyhna.default_tools_approval_mode, 'approve');

const { ADAPTER_VERSION } = await import(pathToFileURL(join(plugin, 'src', 'version.mjs')).href);
assert.equal(packageJson.version, portableManifest.version);
assert.equal(ADAPTER_VERSION, portableManifest.version);
assert.match(
  openaiHookBridge,
  /^\/\/ OpenAI plugin entrypoint\.[^\n]*\nimport '\.\.\/ai\.lyhna\.codex\/hooks\/capture\.mjs';\r?\n$/,
  'the OpenAI hook entrypoint must stay a behavior-free bridge to the shared implementation'
);

for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
  assert(Array.isArray(openaiHooks.hooks?.[event]) && openaiHooks.hooks[event].length > 0, `${event} OpenAI hook missing`);
  for (const group of openaiHooks.hooks[event]) {
    for (const hook of group.hooks || []) {
      assert.match(hook.command || '', /PLUGIN_ROOT/);
      assert.match(hook.commandWindows || '', /PLUGIN_ROOT/);
      assert.match(hook.command || '', /hooks\/capture\.mjs/);
      assert.match(hook.commandWindows || '', /hooks\\capture\.mjs/);
      assert.doesNotMatch(hook.command || '', /PLUGIN_DATA|LYHNA_CODEX_DATA/);
      assert.doesNotMatch(hook.commandWindows || '', /PLUGIN_DATA|LYHNA_CODEX_DATA/);
    }
  }
  assert(Array.isArray(extensionHooks.hooks?.[event]) && extensionHooks.hooks[event].length > 0, `${event} hook missing`);
  for (const group of extensionHooks.hooks[event]) {
    for (const hook of group.hooks || []) {
      assert(existsSync(join(plugin, 'ai.lyhna.codex', 'hooks', 'capture.mjs')));
      assert.match(hook.command || '', /PLUGIN_ROOT/);
      assert.match(hook.commandWindows || '', /PLUGIN_ROOT/);
      assert.match(hook.command || '', /ai\.lyhna\.codex/);
      assert.match(hook.commandWindows || '', /ai\.lyhna\.codex/);
      assert.match(hook.command || '', /LYHNA_CODEX_DATA="\$\{PLUGIN_DATA\}"/);
      assert.match(hook.commandWindows || '', /LYHNA_CODEX_DATA=\$env:PLUGIN_DATA/);
    }
  }
}

assert.match(skill, /^---\r?\nname: lyhna\r?\n/m);
const entry = marketplace.plugins?.find((item) => item.name === portableManifest.name);
assert(entry, 'marketplace entry missing');
assert.equal(entry.source?.path, './plugins/lyhna');

console.log(`Validated ${portableManifest.name} ${portableManifest.version}`);
