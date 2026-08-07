import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = resolve('plugins', 'lyhna');
const json = (path) => JSON.parse(readFileSync(join(plugin, path), 'utf8'));
const portableManifest = json('plugin.json');
const portableMcp = json('mcp.json');
const manifest = json(join('.codex-plugin', 'plugin.json'));
const mcp = json('.mcp.json');
const packageJson = json('package.json');
const hooks = json(join('hooks', 'hooks.json'));
const extensionHooks = json(join('ai.lyhna.codex', 'hooks', 'hooks.json'));
const marketplace = JSON.parse(readFileSync(resolve('.agents', 'plugins', 'marketplace.json'), 'utf8'));
const skill = readFileSync(join(plugin, 'skills', 'lyhna', 'SKILL.md'), 'utf8');

assert.equal(manifest.name, 'lyhna-codex-adapter');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
for (const relative of [manifest.skills, manifest.mcpServers]) {
  assert(relative?.startsWith('./'));
  assert(existsSync(join(plugin, relative)));
}
assert.deepEqual(extensionHooks, hooks);

assert.deepEqual(
  Object.keys(portableManifest).sort(),
  ['$schema', 'author', 'description', 'homepage', 'keywords', 'name', 'repository', 'version'].sort()
);
assert.equal(portableManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(portableManifest.name, manifest.name);
assert.equal(portableManifest.version, manifest.version);
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

assert.equal(mcp.mcpServers, undefined, 'the manifest spelling is invalid inside .mcp.json');
assert.equal(mcp.mcp_servers, undefined, 'Codex 0.144.1 misparses the documented wrapper; use a direct server map');
assert.deepEqual(Object.keys(mcp), ['lyhna']);
const server = mcp.lyhna;
assert.equal(server?.command, 'node');
assert.deepEqual(server?.args, ['./src/mcp-server.mjs']);
assert.deepEqual(server?.env_vars, ['LYHNA_CODEX_DATA']);
assert.equal(server?.cwd, '.');
assert.equal(server?.default_tools_approval_mode, 'approve');
const { ADAPTER_VERSION } = await import(pathToFileURL(join(plugin, 'src', 'version.mjs')).href);
assert.equal(packageJson.version, manifest.version);
assert.equal(packageJson.version, portableManifest.version);
assert.equal(ADAPTER_VERSION, manifest.version);

for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
  assert(Array.isArray(hooks.hooks?.[event]) && hooks.hooks[event].length > 0, `${event} hook missing`);
  for (const group of hooks.hooks[event]) {
    for (const hook of group.hooks || []) {
      assert(existsSync(join(plugin, 'hooks', 'capture.mjs')));
      assert(existsSync(join(plugin, 'ai.lyhna.codex', 'hooks', 'capture.mjs')));
      assert.match(hook.commandWindows || '', /PLUGIN_ROOT/);
      assert.match(hook.commandWindows || '', /hooks/);
    }
  }
}

assert.match(skill, /^---\r?\nname: lyhna\r?\n/m);
const entry = marketplace.plugins?.find((item) => item.name === manifest.name);
assert(entry, 'marketplace entry missing');
assert.equal(entry.source?.path, './plugins/lyhna');

console.log(`Validated ${manifest.name} ${manifest.version}`);
