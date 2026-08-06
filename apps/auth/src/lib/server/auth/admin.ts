import { env } from '$env/dynamic/private';
import type { SessionUser } from '@civitai/auth';

// Hub admin allowlist — the user ids allowed into /admin (currently the TrustedSpokeDomain registry editor).
// Sourced from AUTH_ADMIN_USER_IDS, a comma-separated list of numeric user ids (e.g. "1,5"). Parsed once at
// module load. FAIL CLOSED: unset/empty (or all-invalid) → no admins, so a missing env locks the area down
// rather than silently opening it. The surface this guards (the first-party login registry) is sensitive, so
// only positive integer ids are accepted; anything else is dropped.
export const ADMIN_USER_IDS: ReadonlySet<number> = new Set(
  (env.AUTH_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);

/** True if this session user is a hub admin (allowed into /admin). */
export function isHubAdmin(user: Pick<SessionUser, 'id'> | undefined | null): boolean {
  return !!user && ADMIN_USER_IDS.has(user.id);
}

/**
 * Paths and route ids belonging to the admin area. Matched on the prefix rather than against a list of known
 * routes so that a route added under /admin later is covered without anyone having to remember to list it.
 */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

// Mirrors SvelteKit's own `decode_pathname` (src/utils/url.js), which is what it matches routes against.
// %25 is held back so an encoded percent is not decoded twice.
function decodePathname(pathname: string): string {
  try {
    return pathname.split('%25').map(decodeURI).join('%25');
  } catch {
    return pathname;
  }
}

/**
 * Whether a request belongs to the admin area.
 *
 * `routeId` is the authoritative arm: SvelteKit resolves routes against the DECODED pathname while
 * `url.pathname` keeps the spelling the client sent, so the two can disagree and the routed id is what
 * actually executes. The pathname arms are kept so an /admin request that matches no route is still
 * rejected here rather than falling through.
 */
export function isAdminRequest(pathname: string, routeId: string | null | undefined): boolean {
  return (
    isAdminPath(pathname) ||
    isAdminPath(decodePathname(pathname)) ||
    (!!routeId && isAdminPath(routeId))
  );
}
