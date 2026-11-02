#!/usr/bin/env node
// Optional acceptance: requires an installed Codex CLI, but no login or model calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePlugin, registerCodex } from './install-agent-plugin.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'contractguard-codex-acceptance-'));
const isolatedHome = path.join(temporary, 'isolated-codex');
const marketplaceRoot = path.join(temporary, '独立 插件 marketplace');
await mkdir(isolatedHome);
// Only this child process uses the new empty home; no user auth/config is copied.
const childEnvironment = { ...process.env, CODEX_HOME: isolatedHome };
const execute = (command, args, options = {}) => spawnSync(command, ['--no-daemon', ...args], {
  ...options, encoding: 'utf8', shell: false, windowsHide: true,
  cwd: temporary, env: childEnvironment, timeout: 60_000,
});
const run = (args) => {
  const result = execute('codex', args);
  if (result.error || result.status !== 0) throw new Error(`Codex acceptance command failed (${args.slice(0, 3).join(' ')}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
try {
  const prepared = await preparePlugin({ outputDirectory: marketplaceRoot });
  const version = run(['--version']).trim();
  const registered = registerCodex(prepared.transport, { execute });
  assert.equal(registered.alreadyInstalled, false);
  const checked = JSON.parse(run(['mcp', 'get', 'contractguard', '--json']));
  assert.equal(checked.transport.command, prepared.transport.command);
  assert.deepEqual(checked.transport.args, prepared.transport.args);
  assert.equal(checked.transport.env.CONTRACTGUARD_API_URL, 'http://127.0.0.1:8080');
  assert.equal(registerCodex(prepared.transport, { execute }).alreadyInstalled, true);
  run(['mcp', 'remove', 'contractguard']);
  run(['plugin', 'marketplace', 'add', marketplaceRoot, '--json']);
  run(['plugin', 'add', 'contractguard@contractguard-local', '--json']);
  const plugins = JSON.parse(run(['plugin', 'list', '--marketplace', 'contractguard-local', '--json']));
  const serialized = JSON.stringify(plugins);
  assert.ok(serialized.includes('contractguard'), 'Installed plugin must be listed.');
  assert.ok(!serialized.includes('"installed":false'), 'Plugin must be installed, not merely available.');
  const pluginMcp = JSON.parse(run(['mcp', 'get', 'contractguard', '--json']));
  assert.equal(pluginMcp.transport.command, 'node');
  assert.equal(pluginMcp.transport.env.CONTRACTGUARD_API_URL, 'http://127.0.0.1:8080');
  assert.ok(pluginMcp.transport.args[0].endsWith('server/index.cjs'));
  const require = createRequire(new URL('../packages/mcp/package.json', import.meta.url));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const client = new Client({ name: 'contractguard-codex-install-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: pluginMcp.transport.command, args: pluginMcp.transport.args,
      ...(pluginMcp.transport.cwd ? { cwd: pluginMcp.transport.cwd } : {}),
      env: pluginMcp.transport.env, stderr: 'pipe',
    }));
    const list = await client.listTools();
    assert.equal(list.tools.length, 19);
    assert.ok(list.tools.some((tool) => tool.name === 'contractguard_start_review'));
  } finally { await client.close(); }
  const temporaryConfig = await readFile(path.join(isolatedHome, 'config.toml'), 'utf8');
  assert.ok(temporaryConfig.includes('contractguard'));
  assert.ok(!(await readdir(isolatedHome)).some((name) => /^auth\./i.test(name)), 'No login state is needed or created.');
  process.stdout.write(`${JSON.stringify({ result: 'passed', codex: version, checks: ['local marketplace registration', 'portable plugin installation', 'installed plugin listing', 'real MCP registration', 'exact executable and argument verification', 'idempotent registration', 'installed plugin runtime handshake and 19 tools', 'no model or login'], userConfigurationChanged: false }, null, 2)}\n`);
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to clean an unexpected temporary path.');
  await rm(temporary, { recursive: true, force: true });
}
