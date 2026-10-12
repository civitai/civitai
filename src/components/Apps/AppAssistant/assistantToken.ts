export const APP_ASSISTANT_TOKEN_ROUTE = '/api/apps/assistant/token';

/** A token this close to expiry is replaced rather than handed out. */
const EXPIRY_MARGIN_MS = 60_000;

/** `chat` can spend Buzz; `sandbox` (the hosted sandbox service and its MCP) only identifies the user. */
export type AssistantTokenPurpose = 'chat' | 'sandbox';

export class AssistantTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `consent_required` until the user turns App Assistant on. */
    readonly code?: string
  ) {
    super(message);
    this.name = 'AssistantTokenError';
  }
}

export interface AssistantTokenProvider {
  getToken(opts?: { refresh?: boolean; purpose?: AssistantTokenPurpose }): Promise<string>;
  /** Turns App Assistant on (writes the user's consent) and returns a chat token. */
  enable(): Promise<string>;
}

type Cached = { token: string; expiresAtMs: number };

/**
 * App Assistant's OAuth access tokens, cached per purpose until shortly before they expire;
 * concurrent callers share one request.
 */
export function createAssistantTokenProvider({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  onConsentRequired,
}: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called when the route says the user has not turned the assistant on (or revoked it). */
  onConsentRequired?: () => void;
} = {}): AssistantTokenProvider {
  const cached = new Map<AssistantTokenPurpose, Cached>();
  const inflight = new Map<AssistantTokenPurpose, Promise<string>>();

  async function request(purpose: AssistantTokenPurpose, method: 'GET' | 'POST') {
    const url =
      method === 'POST' ? APP_ASSISTANT_TOKEN_ROUTE : `${APP_ASSISTANT_TOKEN_ROUTE}?for=${purpose}`;
    const res = await fetchImpl(
      url,
      method === 'POST'
        ? {
            method,
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        : { method, credentials: 'same-origin' }
    );
    const data = (await res.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
      error?: unknown;
      code?: unknown;
    } | null;
    if (!res.ok || typeof data?.token !== 'string') {
      if (data?.code === 'consent_required') onConsentRequired?.();
      throw new AssistantTokenError(
        typeof data?.error === 'string' ? data.error : 'Could not start an App Assistant session',
        res.status,
        typeof data?.code === 'string' ? data.code : undefined
      );
    }
    const expiresAtMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    cached.set(purpose, {
      token: data.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
    });
    return data.token;
  }

  function shared(purpose: AssistantTokenPurpose, method: 'GET' | 'POST') {
    let pending = inflight.get(purpose);
    if (!pending) {
      cached.delete(purpose);
      pending = request(purpose, method).finally(() => inflight.delete(purpose));
      inflight.set(purpose, pending);
    }
    return pending;
  }

  return {
    getToken({ refresh = false, purpose = 'chat' } = {}) {
      const hit = cached.get(purpose);
      if (!refresh && hit && hit.expiresAtMs - EXPIRY_MARGIN_MS > now())
        return Promise.resolve(hit.token);
      return shared(purpose, 'GET');
    },
    enable() {
      // Tokens minted before a revoke were deleted with the consent.
      cached.clear();
      return shared('chat', 'POST');
    },
  };
}
