import { hubFetch } from './hub';
import { deviceCookieName, sessionCookieName } from './cookies';
import { loadAuthEnv } from './env';

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
  /**
   * Migration-window upgrade-on-read: hand the hub a still-valid LEGACY next-auth cookie and get back a fresh
   * civ-token for the SAME user. The hub re-decodes the legacy cookie (it holds NEXTAUTH_SECRET) to prove the
   * bearer's identity — so the legacy cookie stays the trust anchor, NOT a "mint anyone" primitive — and the
   * call is additionally service-authed by AUTH_INTERNAL_TOKEN so only a trusted spoke server can invoke it.
   * Null on any failure/timeout (the caller keeps serving from its own local legacy decode and retries next
   * request). Drop alongside the legacy decode once old cookies age out.
   */
  exchangeLegacy(
    legacyToken: string,
    opts?: { deviceCookie?: string; timeoutMs?: number }
  ): Promise<{ token: string; deviceId?: string } | null>;
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
    async exchangeLegacy(legacyToken, opts) {
      if (!legacyToken) return null;
      const internal = loadAuthEnv().AUTH_INTERNAL_TOKEN;
      if (!internal) return null; // service secret unset — no upgrade path, fall back to local legacy decode
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 2500);
      try {
        const res = await hubFetch('/api/auth/oauth/legacy-exchange', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${internal}`, // proves the caller is a trusted spoke server
            'content-type': 'application/json',
            // Forward any existing device cookie so the hub reuses this browser's device set instead of minting
            // a fresh one (and orphaning the old). Absent for a pure legacy user → the hub mints + returns one.
            ...(opts?.deviceCookie ? { cookie: `${deviceCookieName()}=${opts.deviceCookie}` } : {}),
          },
          body: JSON.stringify({ legacyToken }), // the legacy cookie itself proves WHO (hub re-decodes it)
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const { token, deviceId } = (await res.json()) as { token?: string; deviceId?: string };
        return token ? { token, deviceId } : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
