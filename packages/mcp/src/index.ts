#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContractGuardMcpServer } from './server.js';
import { AdapterError, MAX_REQUEST_BYTES } from './client.js';

async function main(): Promise<void> {
  const server = createContractGuardMcpServer({
    ...(process.env.CONTRACTGUARD_API_URL === undefined ? {} : { apiUrl: process.env.CONTRACTGUARD_API_URL }),
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_REQUEST_BYTES + 64 * 1024 });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => { process.exitCode = 0; });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  // Never write diagnostics to stdout: it belongs exclusively to the MCP transport.
  process.stderr.write(`${error instanceof AdapterError ? error.message : 'ContractGuard MCP could not start.'}\n`);
  process.exitCode = 1;
});
