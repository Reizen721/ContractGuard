export const DEFAULT_API_URL = 'http://127.0.0.1:8080';
export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    readonly operationMayHaveCompleted = false,
  ) { super(message); this.name = 'AdapterError'; }
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalidUrl();
  return url.origin;
}

function invalidUrl(): AdapterError {
  return new AdapterError('INVALID_API_URL', 'CONTRACTGUARD_API_URL must be a loopback HTTP origin, for example http://127.0.0.1:8080. Paths, credentials, remote hosts, query strings and fragments are not allowed.');
}

export interface ClientOptions {
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Test/embedding option; does not accept per-tool endpoints or credentials. */
  timeoutMs?: number;
}

export class ContractGuardClient {
  readonly apiUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(options.apiUrl ?? DEFAULT_API_URL);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 240_000) {
      throw new AdapterError('INVALID_TIMEOUT', 'HTTP timeout must be between 1 and 240000 ms.');
    }
  }

  async request(path: string, options: {
    method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal;
    text?: boolean; timeoutMs?: number;
  } = {}): Promise<unknown> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.startsWith('//')) {
      throw new AdapterError('INVALID_API_PATH', 'Only fixed ContractGuard API routes are allowed.');
    }
    const method = options.method ?? 'GET';
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new AdapterError('INPUT_TOO_LARGE', 'The serialized request exceeds the 12 MiB adapter limit. Each contract is also limited to 5 MiB by the service.');
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(`${this.apiUrl}${path}`, {
        method, signal, redirect: 'error',
        headers: { Accept: options.text ? 'text/plain, application/json' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
      const text = await readBounded(response, method === 'POST');
      let parsed: unknown;
      if (!response.ok || !options.text) {
        try { parsed = JSON.parse(text) as unknown; }
        catch { throw new AdapterError('INVALID_API_RESPONSE', 'The local service returned an invalid JSON response. Check that ContractGuard is running at the configured port.', response.status, method === 'POST'); }
      }
      if (!response.ok) {
        const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
        const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'API_ERROR';
        const message = typeof error.message === 'string' ? error.message.slice(0, 1500) : 'The ContractGuard service rejected the request.';
        throw new AdapterError(code, message, response.status);
      }
      return options.text ? text : parsed;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (options.signal?.aborted) throw new AdapterError('REQUEST_CANCELLED', 'The MCP request was cancelled. For a submitted background review, use its run ID to cancel the run separately.', undefined, method === 'POST');
      if (timeout.aborted) throw new AdapterError('API_TIMEOUT', 'The ContractGuard service did not answer before the timeout. Check history before repeating a creation request.', undefined, method === 'POST');
      throw new AdapterError('API_UNREACHABLE', 'Cannot reach the local ContractGuard service. Start start-contractguard.bat (or pnpm start), then retry. The adapter does not start a second service or read API keys.', undefined, method === 'POST');
    }
  }
}

async function readBounded(response: Response, mutation: boolean): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw responseTooLarge(mutation);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw responseTooLarge(mutation); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

function responseTooLarge(mutation: boolean): AdapterError {
  return new AdapterError('RESPONSE_TOO_LARGE', 'The service response exceeds the 16 MiB adapter limit. Use the web application for this unusually large report/history. A creation request may already be saved; do not blindly repeat it.', undefined, mutation);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
