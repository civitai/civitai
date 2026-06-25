import { createSessionClient } from './session-client';
import { sessionCookieName } from './cookies';
import { hubBaseUrl } from './hub';
import type { SessionUser, SessionClaims } from './types';

// SPOKE GUARD — the framework-agnostic request gate every FIRST-PARTY app (Next or SvelteKit) uses to protect
// itself. It operates purely on a Cookie header string and returns a decision, so the per-framework adapter is
// ~5 lines (read the cookie header → call check() → act on the result). Same core, same config, both runtimes.
//
// Resolves the RICH user via createSessionClient (verify → shared cache → hub /api/auth/identity on miss), so
// role checks like `isModerator` work (the thin token carries identity only). No redis required — the cache
// read fails open to the hub identity fetch; wire a cache redis only to avoid a per-request hub hop.

export type SpokeGuardResult =
  /** Authenticated and authorized — render the request as `user`. */
  | { status: 'ok'; user: SessionUser }
  /** No valid session — send the browser to the hub login (it returns to `returnUrl` after). */
  | { status: 'login'; redirect: string }
  /** Authenticated but fails `require` (e.g. not a moderator) — 403. NOT a login redirect: re-login can't help. */
  | { status: 'forbidden'; user: SessionUser };

export interface SpokeGuardConfig {
  /** Extra authorization beyond "is logged in" — e.g. `(u) => u.isModerator`. Omit to allow any signed-in user. */
  require?: (user: SessionUser) => boolean;
  /**
   * Injected revocation check (shared redis TOKEN_STATE marker). Without it the gate is signature+expiry only —
   * a logged-out/banned token still resolves on a cache hit. Wire it (like the main app) for real-time
   * revocation; omit on apps with no redis client (a signature-only gate). Fail-open inside.
   */
  isRevoked?: (claims: SessionClaims) => boolean | Promise<boolean>;
  /** Hub login path. Default `/login`. */
  loginPath?: string;
}

export interface SpokeGuard {
  /**
   * @param cookieHeader the request's raw `Cookie` header (`''` if absent)
   * @param returnUrl    the absolute URL to come back to after login (the current request URL)
   */
  check(cookieHeader: string, returnUrl: string): Promise<SpokeGuardResult>;
}

export function createSpokeGuard(config: SpokeGuardConfig = {}): SpokeGuard {
  const sessions = createSessionClient({ isRevoked: config.isRevoked });
  const cookieName = sessionCookieName();
  const loginPath = config.loginPath ?? '/login';

  const loginRedirect = (returnUrl: string): string => {
    const base = hubBaseUrl() ?? ''; // hub origin (AUTH_JWT_ISSUER); '' is a degenerate misconfig fallback
    return `${base}${loginPath}?returnUrl=${encodeURIComponent(returnUrl)}`;
  };

  async function check(cookieHeader: string, returnUrl: string): Promise<SpokeGuardResult> {
    const token = readCookie(cookieHeader, cookieName);
    const user = token ? await sessions.getSessionUser(token) : null;
    if (!user) return { status: 'login', redirect: loginRedirect(returnUrl) };
    if (config.require && !config.require(user)) return { status: 'forbidden', user };
    return { status: 'ok', user };
  }

  return { check };
}

/** Pull a single cookie value out of a `Cookie` header string. */
function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
