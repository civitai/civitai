import type { APIRequestContext } from '@playwright/test';

/**
 * Minimal tRPC client for the preview e2e tests, used to SELF-SEED uniquely-tagged
 * fixtures (e.g. a Post to report) so mutation tests don't collide on the shared
 * dev-DB across concurrent previews. NOT a test file (excluded from testMatch).
 *
 * civitai is tRPC v11 with the **superjson** transformer and batching (src/server/
 * trpc.ts, src/utils/trpc.ts). We mirror the real client's batched wire format:
 *   POST /api/trpc/<proc>?batch=1   body {"0":{"json":<input>}}
 *   GET  /api/trpc/<proc>?batch=1&input=<urlenc({"0":{"json":<input>}})>
 *   response: [{ result: { data: { json: <output> } } }]
 *
 * Two server-side gotchas the recon surfaced:
 *  - CSRF/origin gate (src/server/createContext.ts): a cookie-authed request is
 *    rejected unless its Origin/Referer host is allowlisted. The preview's own
 *    host is (NEXTAUTH_URL = the preview URL), so we stamp Origin+Referer.
 *  - guardedProcedure (post/report create) needs onboarding complete + not muted;
 *    the ci-smoke fixtures are seeded with onboarding=15, so they pass.
 *
 * Pass `page.request` (which carries the test's storageState auth cookie) as the
 * `request` arg from inside a test that set `storageState`.
 */

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

function csrfHeaders(): Record<string, string> {
  return { origin: PREVIEW_URL, referer: `${PREVIEW_URL}/` };
}

function unwrap(body: unknown, proc: string): unknown {
  const entry = Array.isArray(body) ? (body as unknown[])[0] : body;
  const e = entry as { error?: unknown; result?: { data?: { json?: unknown } } };
  if (e?.error) {
    throw new Error(`tRPC ${proc} returned error: ${JSON.stringify(e.error).slice(0, 400)}`);
  }
  return e?.result?.data?.json;
}

export async function trpcMutation<T = unknown>(
  request: APIRequestContext,
  proc: string,
  input: unknown
): Promise<T> {
  const res = await request.post(`/api/trpc/${proc}?batch=1`, {
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    data: { '0': { json: input } },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(`tRPC mutation ${proc} -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return unwrap(body, proc) as T;
}

export async function trpcQuery<T = unknown>(
  request: APIRequestContext,
  proc: string,
  input?: unknown
): Promise<T> {
  const enc = encodeURIComponent(JSON.stringify({ '0': { json: input ?? {} } }));
  const res = await request.get(`/api/trpc/${proc}?batch=1&input=${enc}`, {
    headers: csrfHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(`tRPC query ${proc} -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return unwrap(body, proc) as T;
}

/**
 * Per-run unique tag, stamped into a seeded entity's free-text field so the test
 * can find exactly its own fixture (and concurrent previews never collide).
 */
export function uniqueToken(label: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `e2e-${label}-${Date.now()}-${rand}`;
}
