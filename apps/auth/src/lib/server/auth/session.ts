import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import {
  familyClaims,
  familyId,
  hostSessionCookieName,
  isSecureCookie,
  maybeCreateSessionSigner,
  readSessionToken,
  SESSION_LINEAGE_MAX_AGE_MS,
  SESSION_COOKIE_BASE,
  sessionCookieMode,
  sessionCookieName,
  sessionCookieNameForSlot,
  SPOKE_AUTHORIZE_PATH,
  type CookieRead,
  type CookieSlot,
  type FamilyClaims,
  type SessionClaims,
  type SessionSigner,
  type SessionUser,
} from '@civitai/auth';
import { sessions } from './registry';
import { getOrCreateDeviceId, linkAccount, rotateDeviceId } from './device';
import { clearOtherCookieNames, cookieDomain } from './cookie';
import { cookieJar } from './cookie-jar';
import { verifier } from './verifier';
import { acceptHubSession } from './lineage';
import { issuePendingAuthz } from './pending-authz';
import { registrableDomain } from './domain';
import { isRefusedModerationAccount } from './moderation-account';

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

/** The shared Civitai Moderation account never gets a session, by any path, including impersonation. */
export function refuseModerationAccount(
  user: { id: number; username?: string | null },
  source: string
): void {
  if (isRefusedModerationAccount(user, source)) error(403, 'This account cannot sign in.');
}

/** Whether this account may be given a new or re-signed session cookie. */
export function canHoldSession(user: SessionUser | null | undefined): user is SessionUser {
  return !!user && !user.bannedAt && !user.deletedAt && !isRefusedModerationAccount(user, 'cookie');
}

/** Seconds a session minted now may live: the normal lifetime, cut short by the 90-day limit and `impExp`. */
export function sessionExpiresIn(lineage: FamilyClaims, now = Date.now()): number {
  let until = now + getSigner().maxAge * 1000;
  if (lineage.iat0 != null) until = Math.min(until, lineage.iat0 + SESSION_LINEAGE_MAX_AGE_MS);
  if (lineage.impExp != null) until = Math.min(until, lineage.impExp);
  return Math.max(1, Math.floor((until - now) / 1000));
}

export interface MintOptions {
  /** The session this one descends from (refreshed, switched or impersonated from, or the browser's prior
   *  session on an add-account login). Null or absent: a new sign-in. */
  parent?: SessionClaims | null;
  /** A fresh interactive sign-in restarts the 90-day clock. */
  iat0?: number;
  clearImpersonation?: boolean;
  impersonatedBy?: number;
}

/**
 * Mint the THIN ES256 session token (identity only — `sub`/`jti`/`signedAt`, NO embedded user; the rich user is
 * resolved per-request from the shared cache) + track it for invalidation. Returns the token and its family; does
 * NOT touch any cookie — callers that own the HTTP response set it themselves.
 */
export async function mintSession(
  user: SessionUser,
  opts: MintOptions = {}
): Promise<{ token: string; family: string }> {
  refuseModerationAccount(user, opts.impersonatedBy ? 'impersonate' : 'mint');
  const now = Date.now();
  const tokenId = randomUUID();
  const lineage = familyClaims(opts.parent ?? null, {
    iat0: opts.iat0,
    clearImpersonation: opts.clearImpersonation || opts.impersonatedBy != null,
    now,
  });
  if (opts.impersonatedBy) lineage.impersonatedBy = opts.impersonatedBy;
  const token = await getSigner().mintSessionToken(
    { signedAt: now, sub: String(user.id), ...lineage },
    { jti: tokenId, expiresIn: sessionExpiresIn(lineage, now) }
  );
  // Best-effort: track the token so it can be invalidated later (logout / ban). A redis blip must not fail.
  await sessions.trackToken(tokenId, user.id).catch(() => {});
  return { token, family: familyId({ sid: lineage.sid, jti: tokenId }) ?? tokenId };
}

/** Re-sign an existing session under the same jti, keeping its lineage and 90-day limit, and re-track it. */
export async function reissueSession(
  claims: SessionClaims,
  userId: number,
  jti: string
): Promise<string> {
  const now = Date.now();
  const lineage = familyClaims(claims, { now });
  const token = await getSigner().mintSessionToken(
    { sub: String(userId), signedAt: now, ...lineage },
    { jti, expiresIn: sessionExpiresIn(lineage, now) }
  );
  await sessions.trackToken(jti, userId).catch(() => undefined);
  return token;
}

export async function mintUserSession(user: SessionUser, opts?: MintOptions): Promise<string> {
  return (await mintSession(user, opts)).token;
}

/** The hub session token this request carries, and which slot it was read from. */
export function readHubSession(cookies: Pick<Cookies, 'get'>): CookieRead | null {
  return readSessionToken(cookieJar(cookies));
}

/**
 * Set the thin-session cookie from an ALREADY-MINTED token — no mint, no device-set touch. Used by endpoints
 * that serve the browser client DIRECTLY (switch / impersonate / exit), so the hub itself lands the
 * `.civitai.com` cookie on a credentialed CORS response. (The main app's proxies don't use this — they read the
 * returned token and set their own cookie, because they also deploy cross-site as `.red`.) The host-only slot
 * is this hub's alone and carries no Domain.
 */
export function setSessionCookie(
  cookies: Cookies,
  token: string,
  slot: CookieSlot = sessionCookieMode()
): void {
  const name = sessionCookieNameForSlot(slot);
  cookies.set(name, token, {
    path: '/',
    domain: slot === 'host' ? undefined : cookieDomain(),
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: 'lax',
    maxAge: getSigner().maxAge,
  });
  // A host-only copy of an earlier session would win over this one once the hub reads host-only first. It is
  // dropped, not rewritten: the next /authorize copies this session afresh.
  const host = hostSessionCookieName();
  if (slot === 'shared' && host !== name && cookies.get(host) !== undefined) {
    cookies.delete(host, { path: '/', secure: true });
  }
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
  refuseModerationAccount(user, 'login');
  const prior = await resolvePriorSession(cookies);
  const priorUserId = prior ? Number(prior.sub) : undefined;

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

  // A sign-in on a browser that already holds a hub session (adding an account, or signing in again) joins that
  // session's family, so one sign-out ends both.
  let family: string | undefined;
  if (!handedOff) {
    const minted = await mintSession(user, {
      parent: prior,
      iat0: Date.now(),
      clearImpersonation: true,
    });
    family = minted.family;
    setSessionCookie(cookies, minted.token);
  }

  // Link this account and family to the browser's records (docs/auth/auth-hub-spoke-overview.md). Records this
  // browser can't show it is signed in to stay with the old device id; the sign-in starts on a new one.
  const proofFamily = prior ? familyId(prior) : undefined;
  // The prior session proves the browser is signed in to its principal: the moderator, when impersonating.
  const priorPrincipal = prior ? prior.impersonatedBy ?? priorUserId : undefined;
  const link = (id: string, proof?: string) =>
    linkAccount(
      id,
      user.id,
      priorPrincipal,
      family ? { family, proofFamily: proof } : undefined
    ).catch(() => 'none' as const);
  if ((await link(getOrCreateDeviceId(cookies), proofFamily)) === 'rotate') {
    await link(rotateDeviceId(cookies));
  }
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

/** The valid session already on this request's civ-token cookie, or undefined. Best-effort. */
async function resolvePriorSession(cookies: Cookies): Promise<SessionClaims | undefined> {
  const token = readHubSession(cookies)?.value;
  if (!token) return undefined;
  try {
    const claims = await verifier.verifyToken(token);
    return claims && Number.isFinite(Number(claims.sub)) && (await acceptHubSession(claims))
      ? claims
      : undefined;
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
  clearOtherCookieNames(cookies, SESSION_COOKIE_BASE, SESSION_COOKIE);
}
