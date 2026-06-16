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

// Resolve the cookie Domain for this host: the registrable domain (civitai.com / civitai.red), matching the
// domain the hub uses so it's the SAME shared *.<domain> cookie rather than a host-only sibling. localhost / IP
// / unknown → undefined (host-only). Assumes a 2-label registrable domain, which is all we deploy.
function cookieDomainForHost(host?: string): string | undefined {
  if (COOKIE_DOMAIN_OVERRIDE) return COOKIE_DOMAIN_OVERRIDE;
  const h = (host ?? '').split(':')[0].toLowerCase();
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : undefined;
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

/**
 * Set the civ-token session cookie from a hub-minted token (Max-Age derived from the token's `exp`). Appends to
 * any Set-Cookie already on the response. Pass `host` (the request's `Host` header) so the cookie Domain matches
 * the serving color; omit it only where there's no request (then the cookie is host-only). Pass `deviceCookie`
 * to roll the device cookie in lockstep (switch + rolling-refresh; impersonation does NOT touch the device set).
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
