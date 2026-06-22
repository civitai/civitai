import type { SessionUser } from '@civitai/auth';

// Hub admin allowlist. The admin area (/admin) — currently the TrustedSpokeDomain registry editor — is
// gated to these user ids only. Kept as a hardcoded set (not env / not a DB role) because it's a tiny,
// rarely-changing list of trusted operators and the surface it guards (the first-party login registry) is
// security-sensitive enough that we don't want it reachable via a misconfigured env var or stale DB flag.
export const ADMIN_USER_IDS: ReadonlySet<number> = new Set([1, 5]);

/** True if this session user is a hub admin (allowed into /admin). */
export function isHubAdmin(user: Pick<SessionUser, 'id'> | undefined | null): boolean {
  return !!user && ADMIN_USER_IDS.has(user.id);
}
