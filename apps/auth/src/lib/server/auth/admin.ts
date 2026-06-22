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
