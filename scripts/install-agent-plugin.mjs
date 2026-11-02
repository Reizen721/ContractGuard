#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const owner = 'contractguard-agent-plugin';
const sourceFiles = [
  'plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json',
  'skills/contractguard/SKILL.md', 'skills/contractguard/agents/openai.yaml',
];

export function normalizeApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API URL must be a local HTTP origin, for example http://127.0.0.1:8080.'); }
  const local = ['localhost', '[::1]', '127.0.0.1'].includes(url.hostname);
  if (!local || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Only a loopback HTTP origin without credentials, a path, query, or fragment is supported.');
  }
  return url.origin;
}

function isWithin(directory, parent) {
  const relative = path.relative(parent, directory);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function prepareDirectory(outputDirectory, repositoryRoot) {
  if (isWithin(repositoryRoot, outputDirectory) || isWithin(outputDirectory, path.join(repositoryRoot, 'plugins'))) {
    throw new Error('Choose a separate output directory, not the repository root, its parents, or the plugin source directory.');
  }
  await mkdir(outputDirectory, { recursive: true });
  const entries = await readdir(outputDirectory);
  if (entries.length) {
    let marker;
    try { marker = JSON.parse(await readFile(path.join(outputDirectory, 'generated.json'), 'utf8')); } catch { /* Unowned directory. */ }
    if (marker?.generatedBy !== owner || marker?.sourceRoot !== repositoryRoot) {
      throw new Error('Output directory already contains files not owned by this generator. Choose an empty --output directory.');
    }
  }
  // Write an ownership marker before generating files so a failed build can be retried.
  await writeFile(path.join(outputDirectory, 'generated.json'), `${JSON.stringify({ generatedBy: owner, sourceRoot: repositoryRoot }, null, 2)}\n`);
}

async function dependencyLicenses(inputs, repositoryRoot) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(repositoryRoot, input));
    while (isWithin(directory, repositoryRoot) && directory !== repositoryRoot) {
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); } catch { /* Walk up. */ }
      if (typeof metadata?.name === 'string' && typeof metadata?.version === 'string') {
        const key = `${metadata.name}@${metadata.version}`;
        if (!packages.has(key)) {
          const names = (await readdir(directory)).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.\-_]|$)/i.test(name)).sort();
          const texts = [];
          for (const name of names) {
            if ((await stat(path.join(directory, name))).isFile()) texts.push(`${name}\n${await readFile(path.join(directory, name), 'utf8')}`);
          }
          if (!texts.length) throw new Error(`Cannot package ${key}: its license text was not found.`);
          packages.set(key, `## ${key}\n\nDeclared license: ${typeof metadata.license === 'string' ? metadata.license : 'See license below'}\n\n${texts.join('\n\n')}`);
        }
        break;
      }
      directory = path.dirname(directory);
    }
  }
  return `# Bundled runtime licenses\n\nThis plugin includes the following dependencies in server/index.cjs. ContractGuard itself is covered by LICENSE.\n\n${[...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n\n---\n\n')}\n`;
}

export function createClientConfigurations({ serverEntry, apiUrl, nodeExecutable = process.execPath }) {
  const transport = { command: nodeExecutable, args: [serverEntry], env: { CONTRACTGUARD_API_URL: normalizeApiUrl(apiUrl) } };
  return {
    mcp: { mcpServers: { contractguard: transport } },
    antigravity: { mcpServers: { contractguard: { ...transport, timeout: 240 } } },
    deepseekHarness: [{ insert: [{
      id: 'mcp-contractguard',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'contractguard', transport: 'stdio',
        ...transport,
        toolCallTimeoutMs: 240_000,
        failOnStartupError: true,
      },
    }] }],
    codex: [
      '# Merge this section into your Codex config; do not replace the whole file.',
      '# No API key belongs here. Start the ContractGuard service separately.',
      '[mcp_servers.contractguard]',
      `command = ${JSON.stringify(nodeExecutable)}`,
      `args = [${JSON.stringify(serverEntry)}]`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 180',
      '',
      '[mcp_servers.contractguard.env]',
      `CONTRACTGUARD_API_URL = ${JSON.stringify(transport.env.CONTRACTGUARD_API_URL)}`,
      '',
    ].join('\n'),
    transport,
  };
}

export async function preparePlugin({ repositoryRoot = scriptRoot, outputDirectory, apiUrl = 'http://127.0.0.1:8080', nodeExecutable = process.execPath } = {}) {
  repositoryRoot = path.resolve(repositoryRoot);
  outputDirectory = path.resolve(outputDirectory ?? path.join(repositoryRoot, '.tools/agent-plugin'));
  apiUrl = normalizeApiUrl(apiUrl);
  const entry = path.join(repositoryRoot, 'packages/mcp/dist/index.js');
  try { await access(entry); } catch { throw new Error('The MCP server is not built. Run pnpm install and pnpm build before preparing the plugin.'); }
  const require = createRequire(path.join(repositoryRoot, 'packages/mcp/package.json'));
  let build;
  try { ({ build } = require('esbuild')); } catch { throw new Error('Plugin build dependency is missing. Run pnpm install in the repository.'); }
  await prepareDirectory(outputDirectory, repositoryRoot);
  const pluginDirectory = path.join(outputDirectory, 'plugins/contractguard');
  for (const relative of sourceFiles) {
    const target = path.join(pluginDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repositoryRoot, 'plugins/contractguard', relative), target);
  }
  await copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(pluginDirectory, 'LICENSE'));
  // Self-contained CJS avoids workspace symlinks and import paths into this checkout.
  const serverEntry = path.join(pluginDirectory, 'server/index.cjs');
  await mkdir(path.dirname(serverEntry), { recursive: true });
  const bundled = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [entry],
    outfile: serverEntry,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'silent',
  });
  await writeFile(path.join(pluginDirectory, 'THIRD_PARTY_LICENSES.md'), await dependencyLicenses(bundled.metafile.inputs, repositoryRoot));
  for (const filename of ['mcp.json', '.mcp.json']) {
    const file = path.join(pluginDirectory, filename);
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.mcpServers.contractguard.env.CONTRACTGUARD_API_URL = apiUrl;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const configuration = createClientConfigurations({ serverEntry, apiUrl, nodeExecutable });
  const mcpConfig = path.join(outputDirectory, 'mcp-config.json');
  const codexConfig = path.join(outputDirectory, 'codex-config.toml');
  const antigravityConfig = path.join(outputDirectory, 'antigravity-mcp.json');
  const deepseekHarnessConfig = path.join(outputDirectory, 'deepseek-harness.cordis.json');
  await writeFile(mcpConfig, `${JSON.stringify(configuration.mcp, null, 2)}\n`);
  await writeFile(codexConfig, configuration.codex);
  await writeFile(antigravityConfig, `${JSON.stringify(configuration.antigravity, null, 2)}\n`);
  // JSON is also valid YAML, so this Cordis fragment can be merged without quote conversion.
  await writeFile(deepseekHarnessConfig, `${JSON.stringify(configuration.deepseekHarness, null, 2)}\n`);
  const marketplace = {
    name: 'contractguard-local',
    interface: { displayName: 'ContractGuard Local' },
    plugins: [{ name: 'contractguard', source: { source: 'local', path: './plugins/contractguard' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
  };
  await mkdir(path.join(outputDirectory, '.agents/plugins'), { recursive: true });
  await writeFile(path.join(outputDirectory, '.agents/plugins/marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
  return { outputDirectory, pluginDirectory, serverEntry, mcpConfig, codexConfig, antigravityConfig, deepseekHarnessConfig, transport: configuration.transport };
}

export function registerCodex(transport, { execute = spawnSync, executable = 'codex' } = {}) {
  const invoke = (args) => execute(executable, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  const prior = invoke(['mcp', 'get', 'contractguard', '--json']);
  if (prior.error) throw new Error('Codex CLI is unavailable. Import the generated config manually; no Codex setting was changed.');
  if (prior.status === 0) {
    let current;
    try { current = JSON.parse(prior.stdout); } catch { throw new Error('Codex returned an unreadable entry; no setting was changed.'); }
    const actual = current.transport ?? current;
    if (current.enabled !== false && actual.command === transport.command && JSON.stringify(actual.args) === JSON.stringify(transport.args) && actual.env?.CONTRACTGUARD_API_URL === transport.env.CONTRACTGUARD_API_URL) return { alreadyInstalled: true };
    throw new Error('Codex already has a different contractguard entry. Review it manually; this installer will not overwrite it.');
  }
  if (!/no mcp server named ['"]?contractguard['"]? (?:was )?found/i.test(String(prior.stderr))) {
    throw new Error('Could not confirm that the Codex entry is absent. No Codex setting was changed.');
  }
  const installed = invoke(['mcp', 'add', 'contractguard', '--env', `CONTRACTGUARD_API_URL=${transport.env.CONTRACTGUARD_API_URL}`, '--', transport.command, ...transport.args]);
  if (installed.error || installed.status !== 0) throw new Error('Codex registration did not complete. The generated config remains available for manual import.');
  return { alreadyInstalled: false };
}

export function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--codex') result.codex = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--output' || argument === '--api-url') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      result[argument === '--output' ? 'outputDirectory' : 'apiUrl'] = value;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/install-agent-plugin.mjs [--output <directory>] [--api-url http://127.0.0.1:8080] [--codex]\n\nDefault: build a portable plugin, local marketplace, and configuration fragments for MCP, Codex, Antigravity, and DeepSeek Harness under .tools/agent-plugin.\nMerge the generated fragments into existing host configuration; do not replace the whole file or unrelated entries.\n--codex additionally registers the MCP server through the Codex CLI; existing different entries are preserved.\nKeep ContractGuard running separately. API keys stay in that service, not the generated plugin.\n');
    return;
  }
  const result = await preparePlugin(options);
  if (options.codex) {
    const installed = registerCodex(result.transport);
    process.stdout.write(installed.alreadyInstalled ? 'Codex already uses this ContractGuard MCP entry.\n' : 'ContractGuard MCP registered in Codex. Open a new chat to load its tools.\n');
    process.stdout.write('For long AI explanations, merge tool_timeout_sec = 180 into [mcp_servers.contractguard] as shown in the generated TOML. The Codex CLI registration command does not set that timeout.\n');
  }
  process.stdout.write(`Portable plugin: ${result.pluginDirectory}\nMCP client config fragment: ${result.mcpConfig}\nCodex config fragment: ${result.codexConfig}\nAntigravity config fragment: ${result.antigravityConfig}\nDeepSeek Harness Cordis fragment (JSON/YAML): ${result.deepseekHarnessConfig}\nLocal marketplace root: ${result.outputDirectory}\nMerge configuration fragments with existing host settings; do not replace unrelated entries.\nRequires Node.js >=22.13 and the local ContractGuard service. No model configuration, account, or API key is included.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Plugin preparation failed.'}\n`); process.exitCode = 1; });
}
