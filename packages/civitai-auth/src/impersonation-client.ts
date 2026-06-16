import { hubFetch } from './hub';

// IMPERSONATION CLIENT — the hub's moderator-impersonation endpoints (section F). Authorized purely by the
// BROWSER's forwarded session cookie: the hub gates `impersonate` on the requester being a MODERATOR (no
// internal token, no extra credential), and `exit` on the session carrying an `impersonatedBy` claim.

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
    try {
      const res = await hubFetch(path, {
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
