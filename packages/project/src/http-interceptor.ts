import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

interface MockRoute {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

interface InterceptConfig {
  routes: MockRoute[];
  captureFile: string;
}

const configPath = process.env.CONTRACTGUARD_INTERCEPT_CONFIG;

if (configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as InterceptConfig;

  const matchRoute = (method: string, pathname: string): MockRoute | undefined => {
    const upper = method.toUpperCase();
    const exact = config.routes.find((r) => r.method.toUpperCase() === upper && r.path === pathname);
    if (exact) return exact;
    const segs = pathname.split('/');
    return config.routes.find((r) => {
      if (r.method.toUpperCase() !== upper) return false;
      const tSegs = r.path.split('/');
      return (
        tSegs.length === segs.length &&
        tSegs.every((part, i) => (/^\{[^{}]+\}$/.test(part) ? Boolean(segs[i]) : part === segs[i]))
      );
    });
  };

  const normalizeHeaders = (initHeaders: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!initHeaders) return out;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return out;
    }
    if (Array.isArray(initHeaders)) {
      for (const pair of initHeaders) {
        if (Array.isArray(pair) && pair.length >= 2) {
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
      return out;
    }
    if (typeof initHeaders === 'object') {
      for (const [k, v] of Object.entries(initHeaders as Record<string, unknown>)) {
        if (v !== undefined) out[k.toLowerCase()] = String(v);
      }
    }
    return out;
  };

  // Hard network airgap on node:http and node:https
  const blockRealNetwork = (): never => {
    throw new Error('ContractGuard airgap: direct external HTTP/HTTPS sockets are blocked during sandboxed verification.');
  };
  http.request = blockRealNetwork as typeof http.request;
  http.get = blockRealNetwork as typeof http.get;
  https.request = blockRealNetwork as typeof https.request;
  https.get = blockRealNetwork as typeof https.get;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ??
      (typeof input === 'object' && !(input instanceof URL) && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const headers = normalizeHeaders(
      init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined),
    );
    let parsedBody: unknown;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }

    const parsedUrl = new URL(rawUrl, 'http://contractguard.local');
    appendFileSync(
      config.captureFile,
      JSON.stringify({
        method,
        url: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers,
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      }) + '\n',
      'utf8',
    );

    const matched = matchRoute(method, parsedUrl.pathname);
    if (!matched) {
      return new Response(
        JSON.stringify({
          error: `Unmatched route in ContractGuard sandbox: ${method} ${parsedUrl.pathname}`,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify(matched.body), {
      status: matched.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
