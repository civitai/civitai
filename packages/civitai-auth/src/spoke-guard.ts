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
  type CookieSlot,
} from './cookies';
import { spokeAuthorizeUrl, spokeSessionCookies } from './spoke-signin';
import type { SessionUser, SessionClaims } from './types';

// SPOKE GUARD — the framework-agnostic request gate every FIRST-PARTY app (Next or SvelteKit) uses to protect
// itself. It operates purely on a Cookie header string and returns a decision, so the per-framework adapter is
// ~5 lines (read the cookie header → call check() → act on the result). Same core, same config, both runtimes.
//
// Resolves the RICH user via createSessionClient (verify → shared cache → hub /api/auth/identity on miss), so
// role checks like `isModerator` work (the thin token carries identity only).
//
// A signed-out page load goes to this app's own /api/auth/authorize in either cookie mode; any other request is
// answered 401 with that URL, since a fetch can't follow a sign-in redirect. Not the hub login: with a live hub
// session and no shared cookie, the hub login returns straight to returnUrl without minting one, and loops.

/**
 * Why a request was sent to sign in. `unavailable`: a session cookie is present but the hub could not resolve
 * it right now — signing in again may not help. `host-cookie`: a valid shared-cookie session on a host-mode
 * page load that needs this host's own cookie.
 */
export type SpokeSignInReason = 'no-session' | 'invalid' | 'unavailable' | 'host-cookie';

export type SpokeGuardResult =
  /** Authenticated and authorized — render the request as `user`, adding `setCookies` to the response. */
  | { status: 'ok'; user: SessionUser; setCookies: string[] }
  /** Sign-in needed (see `reason`) — redirect the browser to `redirect` (it returns to `returnUrl` after). */
  | { status: 'login'; redirect: string; reason: SpokeSignInReason }
  /** Sign-in needed on a non-navigation request — answer 401 (`spokeReauthResponse`). */
  | { status: 'reauth'; authorize: string; reason: SpokeSignInReason }
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
  /** Seconds after which a session is rolled (AUTH_SESSION_UPDATE_AGE, default 24h). */
  updateAgeSeconds?: number;
  sessionTokenClient?: Pick<SessionTokenClient, 'refresh'>;
  onRollFailed?: (reason: RefreshFailure) => void;
  /** Called with the cookie slot an authenticated request's session was read from. */
  onSessionSlot?: (slot: CookieSlot) => void;
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
  const updateAgeMs =
    (config.updateAgeSeconds ?? (Number(process.env.AUTH_SESSION_UPDATE_AGE) || 24 * 60 * 60)) *
    1000;
  let tokens = config.sessionTokenClient;
  // Concurrent requests carrying the same aged token share one hub refresh.
  const rolling = new Map<string, Promise<string | undefined>>();

  const signIn = (
    returnUrl: string,
    navigation: boolean,
    reason: SpokeSignInReason
  ): SpokeGuardResult => {
    const authorize = spokeAuthorizeUrl(returnUrl);
    return navigation
      ? { status: 'login', redirect: authorize, reason }
      : { status: 'reauth', authorize, reason };
  };

  async function roll(
    token: string,
    jar: Record<string, string>,
    device: CookieRead | null
  ): Promise<string[]> {
    const iat = issuedAtMs(token);
    if (!iat || Date.now() - iat < updateAgeMs) return [];
    tokens ??= createSessionTokenClient();
    let pending = rolling.get(token);
    if (!pending) {
      pending = tokens
        .refresh(token, { deviceCookie: device?.value, onFailure: config.onRollFailed })
        .then((r) => r?.token)
        .finally(() => rolling.delete(token));
      rolling.set(token, pending);
    }
    const fresh = await pending;
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
    let read = readSessionToken(jar, { host: null });
    if (!read) return signIn(returnUrl, navigation, 'no-session');
    let resolved = await sessions.resolveSessionUser(read.value);
    // A dead shared cookie outlives the host one sign-in sets (a host-only expiry can't remove a Domain cookie), so
    // without this fallback every sign-in would come back to the same invalid shared token and start over. The host
    // token may name a different user than the dead shared one; it is this host's own, verified and revocation-checked.
    if (!resolved.user && resolved.reason === 'invalid' && read.slot === 'shared') {
      const own = readSessionToken(jar, { host: null, mode: 'host' });
      if (own?.slot === 'host') {
        const ownResolved = await sessions.resolveSessionUser(own.value);
        // A host session the hub can't resolve right now is unknown, not absent: report it as such.
        if (ownResolved.user || ownResolved.reason === 'unavailable')
          [read, resolved] = [own, ownResolved];
      }
    }
    if (!resolved.user) return signIn(returnUrl, navigation, resolved.reason);
    const { user } = resolved;
    try {
      config.onSessionSlot?.(read.slot);
    } catch {
      // Observability only: a failing callback never changes the decision.
    }
    if (config.require && !config.require(user)) return { status: 'forbidden', user };

    const mode = sessionCookieMode(null);
    // A host-mode page load carrying only the shared cookie signs in on this host, so it gets its own cookie.
    if (mode === 'host' && read.slot === 'shared' && navigation) {
      return { status: 'login', redirect: spokeAuthorizeUrl(returnUrl), reason: 'host-cookie' };
    }
    // The spoke rolls only its own host-only cookie; the shared one is rolled by the hub and the main app.
    const setCookies =
      rollSlot(read, mode) === 'host'
        ? await roll(read.value, jar, readDeviceId(jar, { host: null }))
        : [];
    return { status: 'ok', user, setCookies };
  }

  return { check };
}
