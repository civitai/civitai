import { SYNC_PARAM } from './constants';

// The login redirect contract — returnUrl handling + cross-domain sync — shared by the hub, the
// main app, and every spoke so they can't drift. Pure functions, framework-agnostic. The
// civitai-origin policy is INJECTED (isAllowedOrigin) rather than hardcoded.

/** returnUrl ?? callbackUrl ?? '/', with the /login recursion guard applied. */
export function readReturnUrl(url: URL): string {
  const raw = url.searchParams.get('returnUrl') ?? url.searchParams.get('callbackUrl') ?? '/';
  return raw.startsWith('/login') ? '/' : raw;
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

/** True for same-origin paths or absolute URLs whose origin is allowed. Rejects `//host`. */
export function isSafeReturnTarget(target: string, opts: ReturnTargetOptions = {}): boolean {
  if (target.startsWith('/') && !target.startsWith('//')) return true;
  try {
    const { origin } = new URL(target);
    return !!opts.allowAllOrigins || !!opts.isAllowedOrigin?.(origin);
  } catch {
    return false;
  }
}

/**
 * Where to send the user after login: the validated returnUrl with the `sync-account` marker re-attached
 * (what the destination's useDomainSync reads). Unsafe targets collapse to '/'.
 * Relative targets stay relative; absolute allowed targets stay absolute.
 */
export function buildPostLoginRedirect(
  returnUrl: string,
  sync: string | null,
  baseOrigin: string,
  opts: ReturnTargetOptions = {}
): string {
  const target = isSafeReturnTarget(returnUrl, opts) ? returnUrl : '/';
  if (!sync) return target;
  try {
    const u = new URL(target, baseOrigin);
    if (!u.searchParams.has(SYNC_PARAM)) u.searchParams.set(SYNC_PARAM, sync);
    return target.startsWith('/') ? `${u.pathname}${u.search}${u.hash}` : u.toString();
  } catch {
    return target;
  }
}
