import { CIVITAI_OWNED_DOMAINS, SYNC_PARAM } from './constants';
import { safeReturnPath } from './return-path';

// The login redirect contract — returnUrl handling + cross-domain sync — shared by the hub, the
// main app, and every spoke so they can't drift. Pure functions, framework-agnostic. `buildPostLoginRedirect`
// keeps the origin policy INJECTED (isAllowedOrigin) so it stays generic + unit-testable; the canonical
// Civitai policy (isCivitaiOrigin) lives here too so every caller injects the SAME one instead of redefining.

/**
 * True when `origin`'s host is an owned eTLD+1 (CIVITAI_OWNED_DOMAINS) or a subdomain of one. An EXACT host
 * check, NOT a substring test: `origin.includes('civitai')` would accept civitai.evil.com / evil-civitai.com /
 * civitai.com.attacker.io (open redirect). The leading dot in the suffix check enforces the subdomain boundary,
 * so xcivitai.com / notcivitai.red are rejected. This is the canonical `isAllowedOrigin` for the post-login
 * redirect — distinct from the OAuth `TrustedSpokeDomain` registry (per-host authorization); see constants.ts.
 */
export function isCivitaiOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!isSecureOrLoopbackOrigin(url)) return false; // no https→http downgrade on an owned host
  const host = url.hostname.toLowerCase();
  return CIVITAI_OWNED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * True for an `https` origin, or any scheme on a loopback host (dev). The post-login redirect guards gate on
 * this so a validated owned/trusted host can't be redirected to over plaintext `http` (which would expose the
 * session cookie to a network MITM). Accepts a parsed URL or an origin string.
 */
export function isSecureOrLoopbackOrigin(origin: string | URL): boolean {
  let url: URL;
  try {
    url = typeof origin === 'string' ? new URL(origin) : origin;
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
    return true;
  return url.protocol === 'https:';
}

/** returnUrl ?? callbackUrl ?? '/', with the /login recursion guard applied. */
export function readReturnUrl(url: URL): string {
  const raw = url.searchParams.get('returnUrl') ?? url.searchParams.get('callbackUrl') ?? '/';
  // Recursion guard: only collapse a returnUrl that points back at the login FORM
  // itself (/login). The /login/oauth/{device,authorize} interaction pages are
  // legitimate post-login destinations and MUST survive. Parse the pathname so a
  // ?code=… query or fragment can't change which path we compare. This guard is
  // ONLY about the /login→/login loop; protocol-relative/external targets (e.g.
  // //evil.com, https://evil.com) are rejected downstream by isSafeReturnTarget,
  // not here.
  let path: string;
  try {
    path = new URL(raw, 'https://placeholder.invalid').pathname;
  } catch {
    return '/';
  }
  if (path === '/login' || path === '/login/') return '/';
  return raw;
}

/** The cross-domain sync marker (`sync-account`). */
export function readSync(url: URL): string | null {
  return url.searchParams.get(SYNC_PARAM);
}

export interface ReturnTargetOptions {
  /** Allow any origin (e.g. in dev). */
  allowAllOrigins?: boolean;
  /** Predicate for allowed absolute-URL origins, e.g. (o) => o.includes('civitai'). */
  isAllowedOrigin?: (origin: string) => boolean;
}

/**
 * The target to actually redirect to, or null when unsafe. A path is accepted only if `safeReturnPath`
 * accepts it, and is returned in that normalised form; an absolute URL only if it is http(s) and its
 * origin is allowed (`allowAllOrigins` widens the origin, never the scheme).
 */
function resolveReturnTarget(target: string, opts: ReturnTargetOptions): string | null {
  if (target.startsWith('/')) return safeReturnPath(target);
  try {
    const { origin, protocol } = new URL(target);
    if (protocol !== 'https:' && protocol !== 'http:') return null;
    return opts.allowAllOrigins || opts.isAllowedOrigin?.(origin) ? target : null;
  } catch {
    return null;
  }
}

/** True for a same-origin path that passes `safeReturnPath`, or an absolute URL whose origin is allowed. */
export function isSafeReturnTarget(target: string, opts: ReturnTargetOptions = {}): boolean {
  return resolveReturnTarget(target, opts) !== null;
}

/**
 * Where to send the user after login: the validated returnUrl with the `sync-account` marker re-attached
 * (what the destination's useDomainSync reads). Unsafe targets collapse to '/'.
 * Relative targets stay relative (in their normalised form); absolute allowed targets stay absolute.
 */
export function buildPostLoginRedirect(
  returnUrl: string,
  sync: string | null,
  baseOrigin: string,
  opts: ReturnTargetOptions = {}
): string {
  const target = resolveReturnTarget(returnUrl, opts) ?? '/';
  if (!sync) return target;
  try {
    const u = new URL(target, baseOrigin);
    if (!u.searchParams.has(SYNC_PARAM)) u.searchParams.set(SYNC_PARAM, sync);
    return target.startsWith('/') ? `${u.pathname}${u.search}${u.hash}` : u.toString();
  } catch {
    return target;
  }
}
