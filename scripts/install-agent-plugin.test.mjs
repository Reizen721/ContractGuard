import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createClientConfigurations, normalizeApiUrl, parseArguments, preparePlugin, registerCodex } from './install-agent-plugin.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installer accepts fixed local origins and rejects remote or credential-bearing URLs', () => {
  assert.equal(normalizeApiUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(normalizeApiUrl('http://[::1]:8090'), 'http://[::1]:8090');
  for (const invalid of ['https://example.com', 'http://127.0.0.1:8080/api', 'http://user:password@localhost', 'http://localhost/?token=x', 'http://localhost/#secret', 'file:///tmp/service']) {
    assert.throws(() => normalizeApiUrl(invalid));
  }
});

test('client configurations preserve spaces, Unicode, and Windows path escaping without shell composition', () => {
  const serverEntry = 'C:\\项目 文件\\ContractGuard\\server\\index.cjs';
  const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
  const result = createClientConfigurations({ serverEntry, apiUrl: 'http://127.0.0.1:8080/', nodeExecutable });
  assert.deepEqual(result.mcp.mcpServers.contractguard.args, [serverEntry]);
  assert.equal(result.mcp.mcpServers.contractguard.command, nodeExecutable);
  assert.equal(result.transport.env.CONTRACTGUARD_API_URL, 'http://127.0.0.1:8080');
  assert.ok(result.codex.includes(`command = ${JSON.stringify(nodeExecutable)}`));
  assert.deepEqual(Object.keys(result.transport.env), ['CONTRACTGUARD_API_URL']);
  assert.deepEqual(result.antigravity.mcpServers.contractguard, { ...result.transport, timeout: 240 });
  assert.deepEqual(result.deepseekHarness, [{ insert: [{ id: 'mcp-contractguard', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'contractguard', transport: 'stdio', ...result.transport,
    toolCallTimeoutMs: 240_000, failOnStartupError: true,
  } }] }]);
});

test('Codex registration preserves an unknown existing entry and is idempotent for an identical entry', () => {
  const transport = { command: process.execPath, args: ['/a path/server.cjs'], env: { CONTRACTGUARD_API_URL: 'http://127.0.0.1:8080' } };
  let calls = 0;
  const same = registerCodex(transport, { execute: () => { calls++; return { status: 0, stdout: JSON.stringify({ transport }) }; } });
  assert.equal(same.alreadyInstalled, true);
  assert.equal(calls, 1);
  assert.throws(() => registerCodex(transport, { execute: () => ({ status: 0, stdout: JSON.stringify({ transport: { ...transport, command: '/other/command' } }) }) }), /will not overwrite/);
  assert.throws(() => registerCodex(transport, { execute: () => ({ status: 1, stderr: 'Cannot parse config' }) }), /No Codex setting was changed/);
});

test('Codex registration uses an argument array only after absence is confirmed', () => {
  const transport = { command: process.execPath, args: ['/a path/中文/server.cjs'], env: { CONTRACTGUARD_API_URL: 'http://127.0.0.1:8080' } };
  const calls = [];
  const result = registerCodex(transport, { execute: (command, args, options) => {
    calls.push({ command, args, options });
    return calls.length === 1 ? { status: 1, stderr: "No MCP server named 'contractguard' found." } : { status: 0, stdout: 'Added.' };
  } });
  assert.equal(result.alreadyInstalled, false);
  assert.deepEqual(calls[1].args, ['mcp', 'add', 'contractguard', '--env', 'CONTRACTGUARD_API_URL=http://127.0.0.1:8080', '--', transport.command, ...transport.args]);
  assert.equal(calls[1].options.shell, false);
});

test('installer rejects unknown or incomplete options', () => {
  assert.deepEqual(parseArguments(['--output', '/some path', '--api-url', 'http://localhost:9000', '--codex']), { outputDirectory: '/some path', apiUrl: 'http://localhost:9000', codex: true });
  assert.throws(() => parseArguments(['--output', '--codex']), /needs a value/);
  assert.throws(() => parseArguments(['--api-key', 'not-supported']), /Unknown option/);
});

test('portable plugin runs after copying to a different Unicode directory, with no workspace dependency links', { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'contractguard-plugin-'));
  const outputDirectory = path.join(temporary, 'generated');
  const relocated = path.join(temporary, '独立 插件 copy');
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/health') response.end(JSON.stringify({ status: 'ok', service: 'contractguard', version: '1.5.0' }));
    else if (request.url === '/api/ai/status') response.end(JSON.stringify({ available: false, enabled: false }));
    else if (request.url === '/api/agent/status') response.end(JSON.stringify({ workflowAvailable: true, llmAvailable: false, engine: { available: true }, planner: { available: false, providers: [] } }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' })); }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${http.address().port}`;
  let client;
  try {
    const prepared = await preparePlugin({ repositoryRoot, outputDirectory, apiUrl });
    const generic = JSON.parse(await readFile(prepared.mcpConfig, 'utf8')).mcpServers.contractguard;
    const antigravity = JSON.parse(await readFile(prepared.antigravityConfig, 'utf8')).mcpServers.contractguard;
    const harness = JSON.parse(await readFile(prepared.deepseekHarnessConfig, 'utf8'))[0].insert[0];
    for (const profile of [antigravity, harness.config]) {
      assert.equal(profile.command, generic.command);
      assert.deepEqual(profile.args, [prepared.serverEntry]);
      assert.deepEqual(profile.env, { CONTRACTGUARD_API_URL: apiUrl });
    }
    assert.equal(antigravity.timeout, 240);
    assert.equal(harness.name, '@deepseek-ai/dsh-mcp-client');
    assert.equal(harness.config.toolCallTimeoutMs, 240_000);
    assert.equal(harness.config.failOnStartupError, true);
    assert.deepEqual(Object.keys(harness.config).sort(), ['args', 'command', 'env', 'failOnStartupError', 'serverName', 'toolCallTimeoutMs', 'transport']);
    await cp(prepared.pluginDirectory, relocated, { recursive: true });
    // Remove the generated original. A cached workspace or output link cannot rescue the copied package.
    await rm(outputDirectory, { recursive: true, force: true });
    const portableManifest = JSON.parse(await readFile(path.join(relocated, 'mcp.json'), 'utf8'));
    const pluginManifest = JSON.parse(await readFile(path.join(relocated, 'plugin.json'), 'utf8'));
    assert.equal(pluginManifest.extensions['com.openai'].requires_local_executor, true);
    assert.equal(portableManifest.mcpServers.contractguard.type, 'stdio');
    const runtime = await readFile(path.join(relocated, 'server/index.cjs'), 'utf8');
    assert.ok(!runtime.includes(repositoryRoot));
    assert.ok(!runtime.includes(repositoryRoot.replaceAll('\\', '/')));
    const licenses = await readFile(path.join(relocated, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    assert.ok(licenses.includes('@modelcontextprotocol/sdk@'));
    assert.ok(licenses.includes('zod@'));
    const require = createRequire(path.join(repositoryRoot, 'packages/mcp/package.json'));
    const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
    client = new Client({ name: 'contractguard-relocation-check', version: '1.0.0' });
    const manifestTransport = portableManifest.mcpServers.contractguard;
    const expandRoot = (value) => value.replaceAll('${PLUGIN_ROOT}', relocated);
    await client.connect(new StdioClientTransport({ command: manifestTransport.command, args: manifestTransport.args.map(expandRoot), cwd: expandRoot(manifestTransport.cwd), env: manifestTransport.env, stderr: 'pipe' }));
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 19);
    assert.ok(listed.tools.some((tool) => tool.name === 'contractguard_status'));
    assert.ok(listed.tools.some((tool) => tool.name === 'contractguard_analyze'));
    assert.ok(listed.tools.some((tool) => tool.name === 'contractguard_review_callers'));
    assert.ok(listed.tools.some((tool) => tool.name === 'contractguard_run_cegar'));
    const status = await client.callTool({ name: 'contractguard_status', arguments: {} });
    assert.notEqual(status.isError, true);
    assert.ok(status.content.some((content) => content.type === 'text' && content.text.includes('contractguard')));
  } finally {
    await client?.close();
    await new Promise((resolve) => http.close(resolve));
    // temporary is a fresh mkdtemp directory owned exclusively by this test.
    await rm(temporary, { recursive: true, force: true });
  }
});

test('packager leaves unrelated output files untouched', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'contractguard-plugin-ownership-'));
  try {
    await writeFile(path.join(temporary, 'keep.txt'), 'user content');
    await assert.rejects(preparePlugin({ repositoryRoot, outputDirectory: temporary }), /not owned/);
    assert.equal(await readFile(path.join(temporary, 'keep.txt'), 'utf8'), 'user content');
    await assert.rejects(preparePlugin({ repositoryRoot, outputDirectory: repositoryRoot }), /separate output directory/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
