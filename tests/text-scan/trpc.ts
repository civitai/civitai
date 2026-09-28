import type { APIRequestContext } from '@playwright/test';

function unwrap(body: unknown, proc: string): unknown {
  const entry = (Array.isArray(body) ? body[0] : body) as {
    error?: unknown;
    result?: { data?: { json?: unknown } };
  };
  if (entry?.error)
    throw new Error(`tRPC ${proc} error: ${JSON.stringify(entry.error).slice(0, 600)}`);
  return entry?.result?.data?.json;
}

export async function trpcMutation<T = unknown>(
  api: APIRequestContext,
  proc: string,
  input: unknown
): Promise<T> {
  const res = await api.post(`/api/trpc/${proc}?batch=1`, {
    headers: { 'content-type': 'application/json' },
    data: { '0': { json: input } },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok())
    throw new Error(`tRPC ${proc} -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 600)}`);
  return unwrap(body, proc) as T;
}

/** Returns the status instead of throwing: read-path specs assert on refusals. */
export async function trpcQuery<T = unknown>(
  api: APIRequestContext,
  proc: string,
  input?: unknown
) {
  const enc = encodeURIComponent(JSON.stringify({ '0': { json: input ?? {} } }));
  const res = await api.get(`/api/trpc/${proc}?batch=1&input=${enc}`);
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status(),
    data: res.ok() ? (unwrap(body, proc) as T) : undefined,
    body,
  };
}
