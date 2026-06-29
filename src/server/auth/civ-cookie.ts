import { sessionCookieName, deviceCookieName, isSecureCookie } from '@civitai/auth';
import { decodeTokenClaim } from './token-claims';

// Shared civ-token Set-Cookie assembly for the spoke proxies that receive a hub-minted token (switch,
// impersonate/exit, rolling refresh) — the hub's Set-Cookie can't cross a same-origin proxy, so each proxy
// re-sets the cookie on its own response. Cookie name + secure-ness come from the package (single source).

// The cookie Domain is ALWAYS derived from the REQUEST host (its registrable domain) — never from an env var.
// The main app serves multiple colors (civitai.com, civitai.red, …) from ONE deployment, so any single fixed
// Domain value is wrong for some color: a civitai.red response can't set Domain=civitai.com (the browser drops
// it, the session cookie never lands, login wedges) AND it makes cookieDomainForHost('civitai.red') fall back to
// host-only, which silently breaks the cross-site logout's same-registrable check. AUTH_COOKIE_DOMAIN is a
// HUB-ONLY concern (the hub is a single host) and is deliberately NOT read here — the main app's cookie scope
// stays decoupled from the hub's env. (Clearing a hub-set `.civitai.com` cookie still works: a Max-Age=0 over
// the derived `civitai.com` deletes a `.civitai.com` cookie — RFC 6265 treats the leading dot as the same scope.)
const DEVICE_TTL_S = 30 * 24 * 60 * 60; // 30d rolling — matches the hub's device record TTL

// True if `domain` (leading dot tolerated) is `host` or a parent of it — i.e. the browser will ACCEPT a
// `Domain=domain` cookie on `host`. A Domain that fails this is silently dropped by the browser, which (for
// the session cookie) presents as an infinite login redirect loop, so callers fall back to host-only instead.
function domainScopesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

// Resolve the cookie Domain for this host: the registrable domain (civitai.com / civitai.red), matching the
// domain the hub uses so it's the SAME shared *.<domain> cookie rather than a host-only sibling. localhost / IP
// / unknown → undefined (host-only). Assumes a 2-label registrable domain, which is all we deploy.
// Exported so logout clears the session/device cookies over the EXACT same Domain scope they were set with
// (a preview/staging SUBDOMAIN sets Domain=civitai.com but clearing only `.{host}` would orphan it).
export function cookieDomainForHost(host?: string): string | undefined {
  const h = (host ?? '').split(':')[0].toLowerCase();
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;

  const parts = h.split('.');
  if (parts.length < 2) return undefined;
  const registrable = parts.slice(-2).join('.');
  // Derived value is a suffix of the host by construction; guard anyway so we never emit a rejected Domain.
  return domainScopesHost(registrable, h) ? registrable : undefined;
}

// Minimal response surface — works for both NextApiResponse and the rolling-refresh path.
export interface CookieWritable {
  getHeader?: (name: string) => number | string | string[] | undefined;
  setHeader: (name: string, value: string | string[]) => void;
}

function buildCookie(
  name: string,
  value: string,
  secure: boolean,
  domain: string | undefined,
  maxAge?: number
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(domain ? [`Domain=${domain}`] : []),
    ...(maxAge != null ? [`Max-Age=${maxAge}`] : []),
  ].join('; ');
}

// The Domain scopes a legacy next-auth cookie could have been set on: host-only, the explicit
// NEXTAUTH_COOKIE_DOMAIN, and the REGISTRABLE domain (civitai.com / civitai.red — where next-auth actually set
// them AND where setSessionCookie plants civ-token). Single source so the session + ancillary clears can't
// drift — using the full-host parent `.{host}` instead would, on a subdomain serving host like
// test-auth.civitai.com, produce `.test-auth.civitai.com` and never match the `.civitai.com` cookie (orphaning
// it; this was a real bug). (oauth2-proxy uses its own `_oauth2_proxy` cookie, never these.)
function legacyClearScopes(host?: string): (string | undefined)[] {
  return [
    ...new Set([
      undefined,
      process.env.NEXTAUTH_COOKIE_DOMAIN || undefined,
      cookieDomainForHost(host),
    ]),
  ];
}

// The legacy next-auth cookie names clearLegacyCookies expires. Used to SKIP the (large) de-crud entirely when
// the browser carries NONE of them (the common post-cutover case), so the hot login-callback response isn't
// bloated with ~24 useless Set-Cookie headers (header bloat can get a real Set-Cookie dropped at the edge).
const LEGACY_COOKIE_NAMES = [
  'civitai-token',
  '__Secure-civitai-token',
  'next-auth.csrf-token',
  '__Host-next-auth.csrf-token',
  'next-auth.callback-url',
  '__Secure-next-auth.callback-url',
  'next-auth.state',
  '__Secure-next-auth.state',
  'next-auth.pkce.code_verifier',
  '__Secure-next-auth.pkce.code_verifier',
  'next-auth.nonce',
  '__Secure-next-auth.nonce',
];

/** True if the request carries any legacy next-auth cookie — i.e. clearLegacyCookies is worth emitting. */
export function hasAnyLegacyCookie(cookies: Partial<Record<string, string>>): boolean {
  return LEGACY_COOKIE_NAMES.some((name) => cookies[name] != null);
}

/**
 * Expire EVERY legacy next-auth cookie a returning pre-cutover user's browser might still carry, across every
 * scope next-auth could have set them on:
 *   - the SESSION cookie (`civitai-token` / prod `__Secure-civitai-token`) — the only one that authenticated a
 *     user; a valid civ-token supersedes it, and getServerAuthSession only falls back to it when civ-token is
 *     absent, so a lingering one keeps a migrated user "logged in" via the stale fallback.
 *   - the ANCILLARY cruft (CSRF, callback-url, and the transient OIDC/OAuth `state` / PKCE `code_verifier` /
 *     `nonce`) — none authenticate, but we de-crud them so the browser is fully cleaned.
 * Call at the auth transitions where these must go: the login callback, upgrade-on-read, and logout. (NOT baked
 * into setSessionCookie — that fires on every rolling refresh, and re-emitting ~30 expiries for already-gone
 * cookies on each refresh is pure waste; the only paths that set a civ-token while a legacy cookie still exists
 * are callback + upgrade, which both call this.) Names are the next-auth defaults (dev: `next-auth.<x>`; prod:
 * secure-prefixed). The CSRF cookie's `__Host-` prefix forbids a Domain attribute, so it's cleared host-only.
 * Remove this whole helper once pre-cutover cookies have aged out.
 */
export function clearLegacyCookies(host?: string): string[] {
  const scopes = legacyClearScopes(host);
  const expire = (name: string, secure: boolean, domain?: string) =>
    `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}${
      domain ? `; Domain=${domain}` : ''
    }`;
  const out: string[] = [
    // CSRF — host-only only (the `__Host-` prefix forbids a Domain attribute).
    expire('next-auth.csrf-token', false),
    expire('__Host-next-auth.csrf-token', true),
  ];
  // The SESSION cookie + callback-url + transient state/pkce/nonce — clear across every scope they could be set
  // on (next-auth Domain-scoped these when NEXTAUTH_COOKIE_DOMAIN was set; otherwise host-only).
  for (const d of scopes) {
    out.push(expire('civitai-token', false, d));
    out.push(expire('__Secure-civitai-token', true, d));
    out.push(expire('next-auth.callback-url', false, d));
    out.push(expire('__Secure-next-auth.callback-url', true, d));
    out.push(expire('next-auth.state', false, d));
    out.push(expire('__Secure-next-auth.state', true, d));
    out.push(expire('next-auth.pkce.code_verifier', false, d));
    out.push(expire('__Secure-next-auth.pkce.code_verifier', true, d));
    out.push(expire('next-auth.nonce', false, d));
    out.push(expire('__Secure-next-auth.nonce', true, d));
  }
  return out;
}

/**
 * Set the civ-token session cookie from a hub-minted token (Max-Age derived from the token's `exp`). Appends to
 * any Set-Cookie already on the response. Pass `host` (the request's `Host` header) so the cookie Domain matches
 * the serving color; omit it only where there's no request (then the cookie is host-only). Pass `deviceCookie`
 * to roll the device cookie in lockstep (switch + rolling-refresh; impersonation does NOT touch the device set).
 * Does NOT clear legacy cookies — the transitions that need that (login callback, upgrade-on-read) call
 * clearLegacyCookies explicitly; keeping it out of here avoids re-emitting the de-crud on every rolling refresh.
 */
export function setSessionCookie(
  res: CookieWritable,
  token: string,
  opts?: { deviceCookie?: string; host?: string }
): void {
  const secure = isSecureCookie();
  const domain = cookieDomainForHost(opts?.host);
  const exp = decodeTokenClaim(token, 'exp');
  const maxAge = exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : undefined;

  const existing = res.getHeader?.('Set-Cookie');
  const all = Array.isArray(existing)
    ? existing.map(String)
    : existing != null
    ? [String(existing)]
    : [];
  all.push(buildCookie(sessionCookieName(), token, secure, domain, maxAge));
  if (opts?.deviceCookie) {
    all.push(buildCookie(deviceCookieName(), opts.deviceCookie, secure, domain, DEVICE_TTL_S));
  }
  res.setHeader('Set-Cookie', all);
}

// ── First-party login loop recovery ───────────────────────────────────────────────────────────────────────
// One-shot marker the callback sets right after minting a session, so /api/auth/authorize can distinguish a
// session cookie that DIDN'T stick (a cross-domain Domain/Secure misconfig — the redirect-loop case) from a
// normal login. Deliberately host-only and NOT Secure: it must stick regardless of the session cookie's fate,
// which is the whole point of using it as the "did the real cookie land?" probe.
export const POST_LOGIN_MARKER = 'civ_postlogin';

/** Set-Cookie for the one-shot post-login marker (60s; host-only; non-secure so it always lands). */
export function postLoginMarkerCookie(): string {
  return `${POST_LOGIN_MARKER}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`;
}

/** Expire the one-shot post-login marker. */
export function clearPostLoginMarker(): string {
  return `${POST_LOGIN_MARKER}=; Path=/; Max-Age=0; SameSite=Lax`;
}

// First-party login RETRY budget, paired with POST_LOGIN_MARKER. When /api/auth/authorize sees the marker but
// NO session cookie, the callback set a civ-token that didn't arrive — EITHER an intermittent cookie-landing
// miss (transient: e.g. the edge dropped a Set-Cookie) OR a real Domain/Secure misconfig (permanent). We RETRY
// the login once (consume the marker, re-enter the flow) so a transient miss self-heals; only on a SECOND
// consecutive miss do we show the terminal "couldn't sign you in" page — that's a genuine redirect loop.
// Host-only + non-secure like the marker so it always lands; short TTL (the whole login chain is a few hops).
export const LOGIN_RETRY_COOKIE = 'civ_login_retry';
const LOGIN_RETRY_TTL_S = 120;

/** Set-Cookie recording the current login-retry count (host-only; always lands, like the marker). */
export function loginRetryCookie(count: number): string {
  return `${LOGIN_RETRY_COOKIE}=${count}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_RETRY_TTL_S}`;
}

/** Expire the login-retry counter (on success, terminal error, or the start of a fresh login chain). */
export function clearLoginRetryCookie(): string {
  return `${LOGIN_RETRY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Expire the civ-token session cookie (BOTH name prefixes) across every plausible Domain scope — host-only and
 * the registrable domain we'd set — plus the marker. A stale, wrong-scope cookie can wedge the session (the
 * spoke reads the bad one and never authenticates); this removes it no matter how it was scoped, so the next
 * login attempt is clean. The registrable scope also clears a hub-set `.civitai.com` cookie (a Max-Age=0 over
 * `civitai.com` deletes a `.civitai.com` cookie — RFC 6265 same scope). Also clears the loop-recovery marker +
 * retry counter so the next attempt starts from zero. Used by the loop-recovery path.
 */
export function clearAllSessionCookies(host?: string): string[] {
  const h = (host ?? '').split(':')[0].toLowerCase();
  const scopes = [...new Set<string | undefined>([undefined, cookieDomainForHost(h)])];
  const out: string[] = [];
  for (const [name, secure] of [
    [sessionCookieName(false), false],
    [sessionCookieName(true), true],
  ] as const) {
    for (const d of scopes) {
      out.push(
        `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}${
          d ? `; Domain=${d}` : ''
        }`
      );
    }
  }
  out.push(clearPostLoginMarker(), clearLoginRetryCookie());
  return out;
}
