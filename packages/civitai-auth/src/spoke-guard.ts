import { decodeJwt } from 'jose';
import { createSessionClient } from './session-client';
import {
  createSessionTokenClient,
  type RefreshFailure,
  type SessionTokenClient,
} from './session-token-client';
import {
  parseCookieHeader,
  readDeviceId,
  readSessionToken,
  rollSlot,
  sessionCookieMode,
  type CookieRead,
} from './cookies';
import { hubBaseUrl } from './hub';
import { spokeAuthorizeUrl, spokeSessionCookies } from './spoke-signin';
import type { SessionUser, SessionClaims } from './types';

// SPOKE GUARD — the framework-agnostic request gate every FIRST-PARTY app (Next or SvelteKit) uses to protect
// itself. It operates purely on a Cookie header string and returns a decision, so the per-framework adapter is
// ~5 lines (read the cookie header → call check() → act on the result). Same core, same config, both runtimes.
//
// Resolves the RICH user via createSessionClient (verify → shared cache → hub /api/auth/identity on miss), so
// role checks like `isModerator` work (the thin token carries identity only).
//
// Where a signed-out browser goes follows AUTH_SESSION_COOKIE_MODE: `shared` sends it to the hub login (the hub's
// shared cookie is the session); `host` sends a page load to this app's own /api/auth/authorize, and answers any
// other request 401 with the authorize URL, since a fetch can't follow a sign-in redirect.

export type SpokeGuardResult =
  /** Authenticated and authorized — render the request as `user`, adding `setCookies` to the response. */
  | { status: 'ok'; user: SessionUser; setCookies: string[] }
  /** No valid session — redirect the browser to `redirect` (it returns to `returnUrl` after). */
  | { status: 'login'; redirect: string }
  /** No valid session on a non-navigation request in host mode — answer 401 (`spokeReauthResponse`). */
  | { status: 'reauth'; authorize: string }
  /** Authenticated but fails `require` (e.g. not a moderator) — 403. NOT a login redirect: re-login can't help. */
  | { status: 'forbidden'; user: SessionUser };

export interface SpokeGuardConfig {
  /** Extra authorization beyond "is logged in" — e.g. `(u) => u.isModerator`. Omit to allow any signed-in user. */
  require?: (user: SessionUser) => boolean;
  /**
   * Revocation check (`createRevocationCheck`). Required: without it a signed-out or banned session still
   * resolves on a cache hit.
   */
  isRevoked: (claims: SessionClaims) => boolean | Promise<boolean>;
  /** Hub login path. Default `/login`. */
  loginPath?: string;
  /** Seconds after which a session is rolled (AUTH_SESSION_UPDATE_AGE, default 24h). */
  updateAgeSeconds?: number;
  sessionTokenClient?: Pick<SessionTokenClient, 'refresh'>;
  onRollFailed?: (reason: RefreshFailure) => void;
}

export interface SpokeGuardCheckOptions {
  /** Whether the request is a page load (`isNavigationRequest`). Default true. */
  navigation?: boolean;
}

export interface SpokeGuard {
  /**
   * @param cookieHeader the request's raw `Cookie` header (`''` if absent)
   * @param returnUrl    the absolute URL to come back to after login (the current request URL)
   */
  check(
    cookieHeader: string,
    returnUrl: string,
    opts?: SpokeGuardCheckOptions
  ): Promise<SpokeGuardResult>;
}

function issuedAtMs(token: string): number | undefined {
  try {
    const { iat } = decodeJwt(token);
    return typeof iat === 'number' ? iat * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function createSpokeGuard(config: SpokeGuardConfig): SpokeGuard {
  if (typeof config?.isRevoked !== 'function') {
    throw new Error(
      '[@civitai/auth] createSpokeGuard requires isRevoked (see createRevocationCheck)'
    );
  }
  const sessions = createSessionClient({ isRevoked: config.isRevoked });
  const loginPath = config.loginPath ?? '/login';
  const updateAgeMs =
    (config.updateAgeSeconds ?? (Number(process.env.AUTH_SESSION_UPDATE_AGE) || 24 * 60 * 60)) *
    1000;
  let tokens = config.sessionTokenClient;

  const hubLogin = (returnUrl: string): string => {
    const base = hubBaseUrl() ?? ''; // hub origin (AUTH_JWT_ISSUER); '' is a degenerate misconfig fallback
    return `${base}${loginPath}?returnUrl=${encodeURIComponent(returnUrl)}`;
  };

  const signIn = (returnUrl: string, navigation: boolean): SpokeGuardResult => {
    if (sessionCookieMode() === 'shared') return { status: 'login', redirect: hubLogin(returnUrl) };
    const authorize = spokeAuthorizeUrl(returnUrl);
    return navigation ? { status: 'login', redirect: authorize } : { status: 'reauth', authorize };
  };

  async function roll(
    token: string,
    jar: Record<string, string>,
    device: CookieRead | null
  ): Promise<string[]> {
    const iat = issuedAtMs(token);
    if (!iat || Date.now() - iat < updateAgeMs) return [];
    tokens ??= createSessionTokenClient();
    const fresh = (
      await tokens.refresh(token, { deviceCookie: device?.value, onFailure: config.onRollFailed })
    )?.token;
    if (!fresh) return [];
    const deviceId = device?.slot === 'host' ? device.value : undefined;
    return spokeSessionCookies(fresh, { slot: 'host', deviceId, requestCookies: jar });
  }

  async function check(
    cookieHeader: string,
    returnUrl: string,
    opts: SpokeGuardCheckOptions = {}
  ): Promise<SpokeGuardResult> {
    const navigation = opts.navigation ?? true;
    const jar = parseCookieHeader(cookieHeader);
    const read = readSessionToken(jar);
    const user = read ? await sessions.getSessionUser(read.value) : null;
    if (!read || !user) return signIn(returnUrl, navigation);
    if (config.require && !config.require(user)) return { status: 'forbidden', user };

    const mode = sessionCookieMode();
    // A host-mode page load carrying only the shared cookie signs in on this host, so it gets its own cookie.
    if (mode === 'host' && read.slot === 'shared' && navigation) {
      return { status: 'login', redirect: spokeAuthorizeUrl(returnUrl) };
    }
    // The spoke rolls only its own host-only cookie; the shared one is rolled by the hub and the main app.
    const setCookies =
      rollSlot(read, mode) === 'host' ? await roll(read.value, jar, readDeviceId(jar)) : [];
    return { status: 'ok', user, setCookies };
  }

  return { check };
}
