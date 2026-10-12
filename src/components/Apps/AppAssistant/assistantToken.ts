export const APP_ASSISTANT_TOKEN_ROUTE = '/api/apps/assistant/token';

/** A token this close to expiry is replaced rather than handed out. */
const EXPIRY_MARGIN_MS = 60_000;

export class AssistantTokenError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AssistantTokenError';
  }
}

export interface AssistantTokenProvider {
  getToken(opts?: { refresh?: boolean }): Promise<string>;
}

/**
 * The App Assistant's OAuth access token, shared by the chat, the sandbox service and the sandbox's
 * MCP. Cached until shortly before it expires; concurrent callers share one request.
 */
export function createAssistantTokenProvider(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now
): AssistantTokenProvider {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const res = await fetchImpl(APP_ASSISTANT_TOKEN_ROUTE, { credentials: 'same-origin' });
    const data = (await res.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || typeof data?.token !== 'string') {
      throw new AssistantTokenError(
        typeof data?.error === 'string' ? data.error : 'Could not start an App Assistant session',
        res.status
      );
    }
    const expiresAtMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    cached = { token: data.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
    return data.token;
  }

  return {
    getToken({ refresh = false } = {}) {
      if (!refresh && cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > now())
        return Promise.resolve(cached.token);
      if (!inflight) {
        cached = null;
        inflight = mint().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
