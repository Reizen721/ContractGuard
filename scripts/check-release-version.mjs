import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PRODUCT_VERSION } from './lib/release-version.mjs';

const root = new URL('../', import.meta.url);
for (const file of [
  'apps/api/package.json', 'apps/cli/package.json', 'apps/web/package.json',
  'packages/core/package.json', 'packages/caller/package.json', 'packages/project/package.json',
  'packages/mcp/package.json', 'packages/oasdiff/package.json',
  'plugins/contractguard/plugin.json', 'plugins/contractguard/.codex-plugin/plugin.json',
]) {
  const json = JSON.parse(await readFile(new URL(file, root), 'utf8'));
  assert.equal(json.version, PRODUCT_VERSION, `${file} must match the release version`);
}
for (const [file, pattern] of [
  ['packages/core/src/analyze.ts', /ENGINE_VERSION = ["']([^"']+)/],
  ['packages/caller/src/index.ts', /CALLER_VERSION = ["']([^"']+)/],
  ['packages/mcp/src/server.ts', /MCP_VERSION = ["']([^"']+)/],
  ['scripts/start-contractguard.ps1', /ContractGuard V([^ ]+) Windows launcher/],
]) {
  const source = await readFile(new URL(file, root), 'utf8');
  assert.equal(source.match(pattern)?.[1], PRODUCT_VERSION, `${file} must advertise the release version`);
}
console.log(`Release versions are consistent: ${PRODUCT_VERSION} (upstream and fixture versions are independent).`);
