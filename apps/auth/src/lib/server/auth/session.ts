import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import {
  isSecureCookie,
  maybeCreateSessionSigner,
  sessionCookieName,
  SPOKE_AUTHORIZE_PATH,
  type SessionSigner,
  type SessionUser,
} from '@civitai/auth';
import { sessions } from './registry';
import { getOrCreateDeviceId, linkAccount } from './device';
import { cookieDomain } from './cookie';
import { verifier } from './verifier';
import { issuePendingAuthz } from './pending-authz';
import { registrableDomain } from './domain';

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

/**
 * Complete a login: establish who the browser is, and link the account to this device's switcher set.
 *
 * `returnUrl` is where the login is headed. When it is an in-flight authorization for a spoke OUTSIDE this
 * hub's cookie scope (civitai.red), the identity travels as a single-use pending record instead of the hub's
 * own session cookie — see foreignScopeSpokeDomain below.
 */
export async function establishSession(
  cookies: Cookies,
  user: SessionUser,
  opts?: { returnUrl?: string }
): Promise<void> {
  // Detect a 2nd-account login BEFORE we overwrite the session cookie: if the browser already carries a valid
  // civ-token for a DIFFERENT user, this login is "add another account" → materialize the switcher set (both
  // accounts). Read it from the incoming cookie (not locals) so this works on every login path uniformly. Done
  // up front because setSessionCookie below queues the new cookie; reading `cookies.get` after that could echo
  // the just-set value. Verification failures (no/expired/invalid prior session) → undefined → no materialize.
  const priorUserId = await resolvePriorSessionUserId(cookies);

  // A login bound for a spoke on another registrable domain must not re-point THIS domain's session — the hub
  // cookie is civitai.com's session too. Hand the identity to /authorize out-of-band instead, leaving whoever
  // was signed in on green signed in. Degrades to the session cookie if the pending record can't be stored:
  // an authorization with no identity anywhere would bounce the user back to /login forever, and no fix is
  // worth breaking the login for.
  //
  // ONLY for a genuine account SWITCH — a prior session belonging to someone else. With no prior session,
  // or a re-login as the same user, withholding the cookie would sign the user out of civitai.com and every
  // *.civitai.com app that reads it, for a login that previously signed them in everywhere.
  const isAccountSwitch = priorUserId !== undefined && priorUserId !== user.id;
  const foreignDomain = isAccountSwitch
    ? await foreignScopeSpokeDomain(opts?.returnUrl)
    : undefined;
  const handedOff = !!foreignDomain && (await issuePendingAuthz(cookies, user.id, foreignDomain));

  if (!handedOff) {
    const token = await mintUserSession(user);
    setSessionCookie(cookies, token);
  }

  // Link this account to the browser's device set (the account-switch list — see
  // docs/auth/auth-hub-spoke-overview.md). LAZY: only writes a
  // `device:accounts:*` key when this is a genuine 2nd distinct account (priorUserId set + != user.id), or when
  // the set already exists. An ordinary single-account login writes nothing. Best-effort.
  // Resolve the device id on its own line FIRST: getOrCreateDeviceId is SYNCHRONOUS and (re)sets the device
  // cookie — keeping it outside the `.catch(...)` chain ensures the cookie-roll always lands and can't be
  // swallowed as if it were part of linkAccount's best-effort redis write.
  const deviceId = getOrCreateDeviceId(cookies);
  await linkAccount(deviceId, user.id, priorUserId).catch(() => {});
}

/**
 * The REGISTRABLE DOMAIN of the spoke this login is headed for, when that spoke is a registered first-party
 * host on a DIFFERENT registrable domain than this hub. Otherwise undefined.
 *
 * `returnUrl` here is the hub's `oauth_return` cookie, which for a spoke login is that spoke's own AUTHORIZE
 * LANDING — `https://civitai.red/api/auth/authorize?returnUrl=...` (buildHubLoginUrl). It is NOT the hub's
 * /api/auth/oauth/authorize and carries no redirect_uri; the spoke adds that on the next hop.
 *
 * Three conditions, each load-bearing:
 *
 * 1. DIFFERENT registrable domain — what makes writing the hub cookie wrong. A same-scope spoke
 *    (civitai.com, moderator.civitai.com, any *.civitai.com app reading civ-token) shares that cookie by
 *    design and must keep getting it.
 * 2. REGISTERED first-party spoke — keeps this off the third-party OAuth flow, which reaches /login with a
 *    hub-relative returnUrl anyway.
 * 3. The landing is the spoke's `/api/auth/authorize` — the ONE shape that produces the second hop where the
 *    pending record gets consumed. Without this, a `createSpokeGuard` app (which sends the raw current page
 *    URL as returnUrl) on a foreign domain would hand off, receive no cookie, land on a page whose guard
 *    finds no session, bounce back to /login with the same returnUrl, and loop forever with no error. Trust
 *    is a `TrustedSpokeDomain` DB row, so that app needs no code change to appear.
 */
async function foreignScopeSpokeDomain(returnUrl?: string): Promise<string | undefined> {
  if (!returnUrl) return undefined;

  // No Domain on our own cookie ⇒ it is host-only ⇒ it is nobody else's session ⇒ nothing to protect.
  // (Dev/localhost, per cookie.ts.) Checked first so local logins never take this path at all.
  const hubDomain = cookieDomain()?.replace(/^\./, '');
  if (!hubDomain) return undefined;

  // Where the login is headed. Only an ABSOLUTE url names another origin — a hub-relative returnUrl is a hub
  // page, or the hub's own /api/auth/oauth/authorize bouncing an unauthenticated third-party authorization
  // through /login, and both are same-scope by definition.
  let origin: string;
  let domain: string | undefined;
  try {
    const url = new URL(returnUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.pathname !== SPOKE_AUTHORIZE_PATH) return undefined;
    origin = url.origin;
    domain = registrableDomain(url.hostname);
  } catch {
    return undefined;
  }
  if (!domain || domain === registrableDomain(hubDomain)) return undefined;

  // Only now — on a genuinely cross-scope login — consult the DB-backed spoke registry. Imported LAZILY
  // because `../oauth/first-party` pulls in `$lib/server/db/db`, which builds a pg Pool at module scope and
  // THROWS without DATABASE_URL. A static import would put that in the graph of everything that touches
  // sessions, including unit tests that have no database.
  const { isFirstPartyOrigin } = await import('../oauth/first-party');
  return (await isFirstPartyOrigin(origin)) ? domain : undefined;
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
