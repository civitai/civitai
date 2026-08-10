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

/**
 * Mirror of SvelteKit's `decode_pathname` (src/utils/url.js) — the form it resolves routes against. Holding
 * `%25` back keeps an encoded percent from decoding twice, and an undecodable path is returned verbatim so it
 * still matches the prefix rather than slipping past it.
 *
 * Exported so a test can pin the mirror against literal expected output. Going through `isAdminRequest`
 * cannot do that: several wrong rewrites of this function produce the same admin/not-admin verdict, so the
 * only thing that catches them drifting from kit is the returned string itself.
 */
export function decodePathname(pathname: string): string {
  try {
    return pathname.split('%25').map(decodeURI).join('%25');
  } catch {
    return pathname;
  }
}

/**
 * Whether a request belongs to the admin area.
 *
 * The decoded pathname is what SvelteKit resolves routes against, so it is what has to agree with the router;
 * `url.pathname` keeps whatever spelling the client sent and can differ. The raw pathname needs no arm of its
 * own — it contains no escape to decode, so it survives `decodePathname` unchanged.
 *
 * `routeId` adds nothing while this app configures no `reroute` hook and no `paths.base`, since the routed id
 * then always agrees with the decoded pathname. It is here as cover for the day one of those is added, which
 * would let a request reach an admin route from a path that does not resemble one.
 */
export function isAdminRequest(pathname: string, routeId: string | null | undefined): boolean {
  return isAdminPath(decodePathname(pathname)) || (!!routeId && isAdminPath(routeId));
}
