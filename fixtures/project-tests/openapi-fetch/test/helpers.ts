import type { MediaType } from "openapi-typescript-helpers";
import createClient from "../src/index.js";
// ContractGuard benchmark adapter. The runtime and GET test assertions remain
// byte-for-byte upstream. This local transport mutation is not an upstream fix.
import { readFileSync } from "node:fs";
const mutation = JSON.parse(readFileSync(new URL("./mutation.json", import.meta.url), "utf8"));

/**
 * Create a client instance where all requests use a custom fetch implementation.
 * This avoids:
 *  - Test implementation footguns
 *  - Shared state/leakage between tests (most mocking libraries including msw)
 *  - Any additional runtime, really—it only processes what you give it
 *
 * ⚠️ YOU MUST MOCK ALL RESPONSES!
 * If you have too much going on in one handler, just make another instance. These are cheap.
 */
// Note: this isn’t called “createMockedClient” because ✨ nothing is mocked 🌈! It’s only calling the handler you pass in.
export function createObservedClient<T extends {}, M extends MediaType = MediaType>(
  options?: Parameters<typeof createClient<T>>[0],
  onRequest: (input: Request) => Promise<Response> = async () => Response.json({ status: 200, message: "OK" }),
) {
  return createClient<T, M>({
    ...options,
    baseUrl: options?.baseUrl || "https://fake-api.example", // Node.js requires a domain for Request(). This restriction doesn’t exist in browsers, but we are using `e2e.test.ts` for that..
    fetch: async (input) => {
      const response = await onRequest(input);
      if (mutation.kind === "none" || new URL(input.url).pathname !== mutation.path || response.status !== 200) return response;
      const body = await response.clone().json();
      if (mutation.kind === "rename") { body[mutation.to] = body[mutation.from]; delete body[mutation.from]; }
      if (mutation.kind === "value") body[mutation.field] = mutation.value;
      return new Response(JSON.stringify(body), { status: mutation.status ?? response.status, headers: response.headers });
    },
  });
}

/**
 * Convert a Headers object to a plain object for easier comparison
 */
export function headersToObj(headers: Headers | Record<string, string>): Record<string, string> {
  const iter =
    headers instanceof Headers
      ? headers
          // @ts-expect-error FIXME: this is a missing "lib" in tsconfig.json but dunno what
          .entries()
      : Object.entries(headers);
  const result: Record<string, string> = {};
  for (const [k, v] of iter) {
    result[k] = v;
  }
  return result;
}
