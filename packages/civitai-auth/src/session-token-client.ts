import { hubFetch } from './hub';
import { deviceCookieName, sessionCookieName } from './cookies';

// SESSION-TOKEN CLIENT — hub operations on a single session token (rolling refresh + revoke), authorized by the
// token ITSELF (a Bearer), not the service secret or the device cookies the sibling clients use.

export interface SessionTokenClient {
  /**
   * Rolling refresh: ask the hub to re-mint the SAME session with a fresh window. Bearer-authed by the token.
   * Pass `deviceCookie` so the hub keeps this browser's active account fresh in its switcher. Null when the hub
   * declines, is unreachable, or times out — the caller keeps the still-valid current token. Times out so a hub
   * blip can't stall the request path (the refresh is fire-safe).
   */
  refresh(
    token: string,
    opts?: { deviceCookie?: string; timeoutMs?: number }
  ): Promise<{ token: string } | null>;
  /** Best-effort token revocation at the hub (logout). Never throws — logout must not block on a hub blip. */
  revoke(token: string): Promise<void>;
}

export function createSessionTokenClient(): SessionTokenClient {
  return {
    async refresh(token, opts) {
      if (!token) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 2500);
      try {
        const res = await hubFetch('/api/auth/refresh', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            // Forward the device cookie so the hub keeps THIS browser's active account fresh in its switcher.
            ...(opts?.deviceCookie ? { cookie: `${deviceCookieName()}=${opts.deviceCookie}` } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const { token: fresh } = (await res.json()) as { token?: string };
        return fresh ? { token: fresh } : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async revoke(token) {
      if (!token) return;
      try {
        await hubFetch('/logout', {
          method: 'POST',
          // Forward under the ACTUAL (env-derived) cookie name so the hub reads it.
          headers: { cookie: `${sessionCookieName()}=${token}` },
          redirect: 'manual',
        });
      } catch {
        // best-effort — the spoke clears its cookies regardless, so the session ends client-side
      }
    },
  };
}
