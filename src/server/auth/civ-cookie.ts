import { sessionCookieName, deviceCookieName, isSecureCookie } from '@civitai/auth';
import { decodeTokenClaim } from './token-claims';

// Shared civ-token Set-Cookie assembly for the spoke proxies that receive a hub-minted token (switch,
// impersonate/exit, rolling refresh) — the hub's Set-Cookie can't cross a same-origin proxy, so each proxy
// re-sets the cookie on its own response. Cookie name + secure-ness come from the package (single source).

// The cookie Domain is derived from the REQUEST host, NOT a static env var — civitai.com and civitai.red share
// one env, so a fixed value would break the other color (a civitai.red response can't set Domain=civitai.com;
// the browser rejects it). AUTH_COOKIE_DOMAIN, if set, is an explicit override for single-color envs (e.g. PR
// previews); leave it UNSET in the shared .com/.red prod env so each color self-derives.
const COOKIE_DOMAIN_OVERRIDE = process.env.AUTH_COOKIE_DOMAIN || undefined;
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
function cookieDomainForHost(host?: string): string | undefined {
  const h = (host ?? '').split(':')[0].toLowerCase();
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;

  // Explicit override wins — but ONLY if it actually scopes this host. A mismatched override (e.g.
  // `.civitai.com` left set in the shared .com/.red env, applied to a .red response) would be rejected by the
  // browser → the spoke can never read its own session → login loop. Drop to host-only + warn instead.
  if (COOKIE_DOMAIN_OVERRIDE) {
    if (domainScopesHost(COOKIE_DOMAIN_OVERRIDE, h)) return COOKIE_DOMAIN_OVERRIDE;
    console.warn(
      `[civ-cookie] AUTH_COOKIE_DOMAIN="${COOKIE_DOMAIN_OVERRIDE}" does not scope host "${h}" — ignoring it ` +
        `and setting a host-only cookie. (Leave AUTH_COOKIE_DOMAIN unset in the shared .com/.red env.)`
    );
    return undefined;
  }

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

// The legacy next-auth session cookie (`civitai-token` / prod `__Secure-civitai-token`). We CLEAR it whenever
// a fresh civ-token is set: a valid civ-token supersedes it (getServerAuthSession only falls back to the
// legacy cookie when civ-token is absent), so leaving it set is stale cruft that keeps a legacy-cookie user
// "logged in" via the fallback. Cleared across the domains next-auth could have used — host-only,
// NEXTAUTH_COOKIE_DOMAIN, and the request-derived `.{host}` parent — mirroring /api/auth/logout's legacy
// clear. (oauth2-proxy uses its own `_oauth2_proxy` cookie, not this one, so it's never the source.) Remove
// this whole helper once legacy cookies have aged out post-cutover.
function clearLegacySessionCookies(host?: string): string[] {
  const h = (host ?? '').split(':')[0].toLowerCase();
  const parent = h && h !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `.${h}` : undefined;
  const domains = [...new Set([undefined, process.env.NEXTAUTH_COOKIE_DOMAIN || undefined, parent])];
  const out: string[] = [];
  for (const [name, secure] of [
    ['civitai-token', false],
    ['__Secure-civitai-token', true],
  ] as const) {
    for (const d of domains) {
      out.push(`${name}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}${d ? `; Domain=${d}` : ''}`);
    }
  }
  return out;
}

/**
 * Set the civ-token session cookie from a hub-minted token (Max-Age derived from the token's `exp`). Appends to
 * any Set-Cookie already on the response. Pass `host` (the request's `Host` header) so the cookie Domain matches
 * the serving color; omit it only where there's no request (then the cookie is host-only). Pass `deviceCookie`
 * to roll the device cookie in lockstep (switch + rolling-refresh; impersonation does NOT touch the device set).
 * Also clears the legacy next-auth cookie — a fresh civ-token supersedes it.
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
  // A valid civ-token supersedes the legacy next-auth cookie → clear it so it doesn't linger.
  all.push(...clearLegacySessionCookies(opts?.host));
  res.setHeader('Set-Cookie', all);
}
