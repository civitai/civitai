import { hubBaseUrl } from './hub';

// IMPERSONATION CLIENT — the consumer-side interface to the hub's moderator-impersonation endpoints (section F).
// Authorized purely by the BROWSER's forwarded session cookie: the hub gates `impersonate` on the requester's
// own session being a MODERATOR (no internal token, no extra credential — that's the whole auth), and `exit`
// on the current session carrying an `impersonatedBy` claim. A spoke proxies these; the hub URL/contract stays
// in the package, never hand-rolled per app.
//
//   impersonate(cookie, userId) → POST {iss}/api/auth/impersonate       — mint a session for userId, stamped
//                                                                          impersonatedBy = the moderator
//   exit(cookie)                → POST {iss}/api/auth/impersonate/exit   — re-mint the moderator's own session

export interface ImpersonationClient {
  /**
   * Start impersonating `userId`. The hub authorizes against the forwarded session (must be a moderator) and
   * returns a freshly minted civ-token for the target carrying `impersonatedBy`. Null when the hub declines
   * (not a moderator / no such user / unreachable); the caller sets the returned token as the session cookie.
   */
  impersonate(cookie: string, userId: number): Promise<{ token: string } | null>;
  /**
   * Stop impersonating: the hub reads `impersonatedBy` from the forwarded session token and returns a fresh
   * civ-token for the MODERATOR. Null when the session isn't an impersonation session, or the hub is unreachable.
   */
  exit(cookie: string): Promise<{ token: string } | null>;
}

export function createImpersonationClient(): ImpersonationClient {
  const post = async (path: string, cookie: string, body?: unknown): Promise<{ token: string } | null> => {
    const base = hubBaseUrl();
    if (!base) return null;
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) return null;
      const { token } = (await res.json()) as { token?: string };
      return token ? { token } : null;
    } catch {
      return null;
    }
  };

  return {
    impersonate: (cookie, userId) => post('/api/auth/impersonate', cookie, { userId }),
    exit: (cookie) => post('/api/auth/impersonate/exit', cookie),
  };
}
