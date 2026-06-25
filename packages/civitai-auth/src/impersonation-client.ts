import { hubFetch } from './hub';

// IMPERSONATION CLIENT — the hub's moderator-impersonation endpoints (section F). Authorized purely by the
// BROWSER's forwarded session cookie: the hub gates `impersonate` on the requester being a MODERATOR (no
// internal token, no extra credential), and `exit` on the session carrying an `impersonatedBy` claim.

/**
 * The hub's response, surfaced to the caller. On failure it carries the hub's real HTTP `status` + `error`
 * message so the proxy can forward the actual cause (e.g. 400 "not an impersonation session", 404, 500) rather
 * than collapsing every failure into one opaque message. `status: 0` means the hub was unreachable/unconfigured.
 */
export type ImpersonationResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error?: string };

export interface ImpersonationClient {
  /**
   * Start impersonating `userId`. The hub authorizes against the forwarded session (must be a moderator) and
   * returns a freshly minted civ-token for the target carrying `impersonatedBy`. On failure returns
   * `{ ok: false, status, error }` (hub declined / no such user / unreachable); the caller sets the returned
   * token as the session cookie.
   */
  impersonate(cookie: string, userId: number): Promise<ImpersonationResult>;
  /**
   * Stop impersonating: the hub reads `impersonatedBy` from the forwarded session token and returns a fresh
   * civ-token for the MODERATOR. On failure returns `{ ok: false, status, error }` (e.g. the session isn't an
   * impersonation session, or the hub is unreachable).
   */
  exit(cookie: string): Promise<ImpersonationResult>;
}

export function createImpersonationClient(): ImpersonationClient {
  const post = async (
    path: string,
    cookie: string,
    body?: unknown
  ): Promise<ImpersonationResult> => {
    let res: Response;
    try {
      res = await hubFetch(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // hub unreachable or unconfigured (AUTH_JWT_ISSUER unset) — status 0 signals "no hub response".
      return { ok: false, status: 0, error: 'hub unreachable' };
    }

    if (!res.ok) {
      // Surface the hub's real reason. SvelteKit `error()` bodies are `{ message }`; our proxy/JSON errors
      // use `{ error }` — read either.
      let error: string | undefined;
      try {
        const data = (await res.json()) as { message?: string; error?: string };
        error = data?.message ?? data?.error;
      } catch {
        // non-JSON body — leave error undefined, the status still carries the signal
      }
      return { ok: false, status: res.status, error };
    }

    const { token } = (await res.json()) as { token?: string };
    return token
      ? { ok: true, token }
      : { ok: false, status: res.status, error: 'no token in hub response' };
  };

  return {
    impersonate: (cookie, userId) => post('/api/auth/impersonate', cookie, { userId }),
    exit: (cookie) => post('/api/auth/impersonate/exit', cookie),
  };
}
