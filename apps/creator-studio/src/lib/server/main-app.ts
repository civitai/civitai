import { env } from '$env/dynamic/private';

// One place for "call the main app as this user". Writes with side effects the main app owns
// (buzz bookkeeping, image ingestion, cache invalidation) go through its REST endpoints with the
// caller's shared .civitai.com session cookie forwarded verbatim, which is what authenticates and
// authorizes the request. Four call sites had grown their own copy of this and the error mapping
// had already diverged between them.
export const MAIN_APP_URL = env.CIVITAI_APP_URL || 'https://civitai.com';

export type MainAppResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function callMainApp<T>(
  path: string,
  cookie: string,
  init?: { method?: string; body?: unknown; parse?: boolean; unreachable?: string }
): Promise<MainAppResult<T>> {
  try {
    const res = await fetch(`${MAIN_APP_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', cookie },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (res.ok) {
      if (init?.parse === false) return { ok: true, data: undefined as T };
      return { ok: true, data: (await res.json()) as T };
    }

    // Endpoints here answer with `error`; a few (and any thrown TRPCError surfaced by one) answer
    // with `message`. Reading only one of them turns a real reason into "Request failed (400)".
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    return {
      ok: false,
      status: res.status,
      error: data?.error ?? data?.message ?? `Request failed (${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      status: 502,
      error: init?.unreachable ?? 'Could not reach the service. Please try again.',
    };
  }
}
