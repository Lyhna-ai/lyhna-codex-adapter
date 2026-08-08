import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ADAPTER_VERSION } from '../src/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('OpenAI and Agent Plugins manifests point to one namespaced hook and MCP implementation', () => {
  const portableManifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  const portableMcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
  const openaiManifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const openaiMcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const openaiHooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const extensionHooks = JSON.parse(readFileSync(join(root, 'ai.lyhna.codex', 'hooks', 'hooks.json'), 'utf8'));
  const openaiHookBridge = readFileSync(join(root, 'hooks', 'capture.mjs'), 'utf8');
  const skill = readFileSync(join(root, 'skills', 'lyhna', 'SKILL.md'), 'utf8');
  assert.equal(portableManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(portableManifest.name, 'lyhna-codex-adapter');
  assert.equal(portableMcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
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
  assert.equal(openaiMcp.lyhna.command, portableMcp.mcpServers.lyhna.command);
  assert.deepEqual(openaiMcp.lyhna.args, ['./src/mcp-server.mjs']);
  assert.deepEqual(openaiMcp.lyhna.env_vars, ['LYHNA_CODEX_DATA']);
  assert.equal(packageJson.version, portableManifest.version);
  assert.equal(ADAPTER_VERSION, portableManifest.version);
  assert.match(openaiHookBridge, /import '\.\.\/ai\.lyhna\.codex\/hooks\/capture\.mjs';/);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
    assert(Array.isArray(openaiHooks.hooks[event]), `${event} OpenAI hook missing`);
    assert(Array.isArray(extensionHooks.hooks[event]), `${event} hook missing`);
    for (const group of openaiHooks.hooks[event]) {
      for (const hook of group.hooks || []) {
        assert.match(hook.command, /hooks\/capture\.mjs/);
        assert.match(hook.commandWindows, /hooks\\capture\.mjs/);
        assert.doesNotMatch(hook.command, /PLUGIN_DATA|LYHNA_CODEX_DATA/);
        assert.doesNotMatch(hook.commandWindows, /PLUGIN_DATA|LYHNA_CODEX_DATA/);
      }
    }
    for (const group of extensionHooks.hooks[event]) {
      for (const hook of group.hooks || []) {
        assert.match(hook.command, /LYHNA_CODEX_DATA="\$\{PLUGIN_DATA\}"/);
        assert.match(hook.commandWindows, /LYHNA_CODEX_DATA=\$env:PLUGIN_DATA/);
      }
    }
  }
  assert.match(skill, /^---\r?\nname: lyhna\r?\n/m);
});

test('manifest-declared plugin variables give the hook and MCP side one data root', { concurrency: false }, (t) => {
  const portableMcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
  const extensionHooks = JSON.parse(readFileSync(join(root, 'ai.lyhna.codex', 'hooks', 'hooks.json'), 'utf8'));
  const pluginData = mkdtempSync(join(tmpdir(), 'lyhna-portable-manifest-'));
  t.after(() => rmSync(pluginData, { recursive: true, force: true }));
  const inherited = Object.fromEntries(
    ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
  const pluginEnv = { ...inherited, PLUGIN_ROOT: root, PLUGIN_DATA: pluginData };
  assert.equal(pluginEnv.LYHNA_CODEX_DATA, undefined, 'the hook test must not manufacture the compatibility override');
  const hook = extensionHooks.hooks.SessionStart[0].hooks[0];
  const hookProcess = process.platform === 'win32'
    ? spawnSync(
      join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', hook.commandWindows],
      { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'portable-manifest-session', cwd: root }), encoding: 'utf8', env: pluginEnv }
    )
    : spawnSync('/bin/sh', ['-c', hook.command], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'portable-manifest-session', cwd: root }),
      encoding: 'utf8',
      env: pluginEnv
    });
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  const hookOutput = JSON.parse(hookProcess.stdout.trim());
  const capability = hookOutput.hookSpecificOutput.additionalContext.match(/LYHNA_SESSION_CAPABILITY=([^\s.]+)/)?.[1];
  assert(capability, 'SessionStart did not mint a capability');

  const configuredMcpEnv = Object.fromEntries(
    Object.entries(portableMcp.mcpServers.lyhna.env).map(([name, value]) => [
      name,
      value.replaceAll('${PLUGIN_ROOT}', root).replaceAll('${PLUGIN_DATA}', pluginData)
    ])
  );
  const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    "import { readFileSync } from 'node:fs';",
    "import { beginRun } from './src/store.mjs';",
    "const { capability } = JSON.parse(readFileSync(0, 'utf8'));",
    "process.stdout.write(beginRun(capability, { mode: 'full', objective: 'Portable manifest data-root probe.' }).id);"
  ].join(' ')], {
    cwd: root,
    input: JSON.stringify({ capability }),
    encoding: 'utf8',
    env: { ...pluginEnv, ...configuredMcpEnv }
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^run_[a-f0-9-]+$/);
});
