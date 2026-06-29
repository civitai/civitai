import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import {
  isSecureCookie,
  maybeCreateSessionSigner,
  sessionCookieName,
  type SessionSigner,
  type SessionUser,
} from '@civitai/auth';
import { sessions } from './registry';
import { getOrCreateDeviceId, linkAccount } from './device';
import { cookieDomain } from './cookie';
import { verifier } from './verifier';

// THE thin-session cookie — a shared contract: every app must use this exact name for SSO to work, so
// it's a hardcoded constant (via the package's single-source-of-truth helper), NOT configurable.
// `civ-token` in dev, `__Secure-civ-token` in prod. DISTINCT from the legacy next-auth `civitai-token`
// cookie, so the two never collide during the cutover.
export const SESSION_COOKIE = sessionCookieName();

let _signer: SessionSigner | null | undefined;
/** The hub ES256 signer. Throws a clear error if the keys aren't configured. */
export function getSigner(): SessionSigner {
  if (_signer === undefined) _signer = maybeCreateSessionSigner();
  if (!_signer) {
    throw new Error(
      '[auth-app] hub signer not configured — set AUTH_JWT_PRIVATE_KEY, AUTH_JWT_KID (+ AUTH_JWT_ISSUER, AUTH_JWT_PUBLIC_KEY)'
    );
  }
  return _signer;
}

// Minimal DB-row → SessionUser projection. Mirrors getSessionUser in the main app, but the
// hub only needs identity-level claims; spokes re-derive the rest on first request if needed.
export function toSessionUser(row: {
  id: number;
  username: string | null;
  email: string | null;
  emailVerified: Date | string | null;
  image: string | null;
  isModerator: boolean | null;
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  onboarding: number;
  createdAt: Date | string;
  deletedAt: Date | string | null;
  muted: boolean;
  bannedAt: Date | string | null;
}): SessionUser {
  return {
    id: row.id,
    username: row.username ?? undefined,
    email: row.email ?? undefined,
    emailVerified: row.emailVerified ? new Date(row.emailVerified) : undefined,
    image: row.image ?? undefined,
    isModerator: row.isModerator ?? false,
    showNsfw: row.showNsfw,
    blurNsfw: row.blurNsfw,
    browsingLevel: row.browsingLevel,
    onboarding: row.onboarding,
    createdAt: new Date(row.createdAt),
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : undefined,
    muted: row.muted,
    bannedAt: row.bannedAt ? new Date(row.bannedAt) : undefined,
  };
}

/**
 * Mint the THIN ES256 session token (identity only — `sub`/`jti`/`signedAt`, NO embedded user; the rich user is
 * resolved per-request from the shared cache) + track it for invalidation. Returns the token; does NOT touch
 * any cookie — callers that own the HTTP response set it themselves. `establishSession` is the cookie-setting
 * wrapper for the login path.
 */
export async function mintUserSession(
  user: SessionUser,
  opts?: { impersonatedBy?: number }
): Promise<string> {
  const tokenId = randomUUID();
  const token = await getSigner().mintSessionToken(
    {
      signedAt: Date.now(),
      sub: String(user.id),
      // Moderator impersonation (F): stamp the moderator's id so the exit path can re-mint their session.
      ...(opts?.impersonatedBy ? { impersonatedBy: opts.impersonatedBy } : {}),
    },
    { jti: tokenId } // the session/token id is the standard `jti` claim — no duplicate `id`
  );
  // Best-effort: track the token so it can be invalidated later (logout / ban). A redis blip must not fail.
  await sessions.trackToken(tokenId, user.id).catch(() => {});
  return token;
}

/**
 * Set the thin-session cookie from an ALREADY-MINTED token — no mint, no device-set touch. Used by endpoints
 * that serve the browser client DIRECTLY (switch / impersonate / exit), so the hub itself lands the
 * `.civitai.com` cookie on a credentialed CORS response. (The main app's proxies don't use this — they read the
 * returned token and set their own cookie, because they also deploy cross-site as `.red`.)
 */
export function setSessionCookie(cookies: Cookies, token: string): void {
  cookies.set(SESSION_COOKIE, token, {
    path: '/',
    domain: cookieDomain(),
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: 'lax',
    maxAge: getSigner().maxAge,
  });
}

export async function establishSession(cookies: Cookies, user: SessionUser): Promise<void> {
  // Detect a 2nd-account login BEFORE we overwrite the session cookie: if the browser already carries a valid
  // civ-token for a DIFFERENT user, this login is "add another account" → materialize the switcher set (both
  // accounts). Read it from the incoming cookie (not locals) so this works on every login path uniformly. Done
  // up front because setSessionCookie below queues the new cookie; reading `cookies.get` after that could echo
  // the just-set value. Verification failures (no/expired/invalid prior session) → undefined → no materialize.
  const priorUserId = await resolvePriorSessionUserId(cookies);

  const token = await mintUserSession(user);
  setSessionCookie(cookies, token);

  // Link this account to the browser's device set (the account-switch list, section E). LAZY: only writes a
  // `device:accounts:*` key when this is a genuine 2nd distinct account (priorUserId set + != user.id), or when
  // the set already exists. An ordinary single-account login writes nothing. Best-effort.
  await linkAccount(getOrCreateDeviceId(cookies), user.id, priorUserId).catch(() => {});
}

/** The userId of the valid session already on this request's civ-token cookie, or undefined. Best-effort. */
async function resolvePriorSessionUserId(cookies: Cookies): Promise<number | undefined> {
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return undefined;
  try {
    const claims = await verifier.verifyToken(token);
    const userId = Number(claims?.sub);
    return Number.isFinite(userId) ? userId : undefined;
  } catch {
    return undefined; // no / expired / invalid prior session ⇒ not a 2nd-account login
  }
}

export function clearSession(cookies: Cookies): void {
  const domain = cookieDomain();
  const secure = isSecureCookie();
  // Clear the Domain-scoped cookie AND a host-only one of the same name. SvelteKit 2.x keys queued cookies by
  // (domain, path, name), so these don't overwrite — both Set-Cookie headers go out. The host-only clear
  // matters because a Domain-scoped delete can't remove a host-only `civ-token` of the same name (e.g. one set
  // during a transitional deploy where cookieDomain() was momentarily host-only); a surviving host-only copy
  // would shadow the cleared domain cookie and keep the session alive after logout.
  cookies.delete(SESSION_COOKIE, { path: '/', secure, domain });
  if (domain) cookies.delete(SESSION_COOKIE, { path: '/', secure });
}
