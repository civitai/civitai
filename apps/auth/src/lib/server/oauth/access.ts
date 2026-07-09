import { db } from '$lib/server/db/db';

// OAuth login gating. Each DB-registered OauthClient carries an `accessMode`:
//   "open"     — anyone may complete /authorize (default; current behaviour)
//   "testers"  — only users holding the "tester" role (UserRole)
//   "disabled" — no one
// First-party (spoke) clients have no OauthClient row and are resolved from the redirect_uri origin, so they
// are NEVER gated here — only third-party clients (e.g. the Comfy desktop/cloud app) are.
//
// Roles are read DIRECTLY from the UserRole table (no Flipt, no session-cache dependency). Each role's user
// set is cached in-memory for ~60s, mirroring the TrustedSpokeDomain registry: an admin-UI write calls
// invalidateRoleCache(role) so the change is live on this instance immediately; other instances pick it up
// on the TTL.

export type AccessMode = 'open' | 'testers' | 'disabled';

export const TESTER_ROLE = 'tester';

const ROLE_TTL_MS = 60_000;
const roleCache = new Map<string, { ids: Set<number>; expiresAt: number }>();

async function getRoleUserIds(role: string): Promise<Set<number>> {
  const now = Date.now();
  const cached = roleCache.get(role);
  if (cached && cached.expiresAt > now) return cached.ids;
  const rows = await db.selectFrom('UserRole').select('userId').where('role', '=', role).execute();
  const ids = new Set(rows.map((r) => r.userId));
  roleCache.set(role, { ids, expiresAt: now + ROLE_TTL_MS });
  return ids;
}

/** Force the next read of `role` (or all roles) to re-query — call after a UserRole write (the admin UI). */
export function invalidateRoleCache(role?: string): void {
  if (role) roleCache.delete(role);
  else roleCache.clear();
}

export async function userHasRole(userId: number, role: string): Promise<boolean> {
  return (await getRoleUserIds(role)).has(userId);
}

export type ClientAccessResult = { allowed: true } | { allowed: false; reason: 'disabled' | 'not_tester' };

/**
 * Decide whether `userId` may complete the /authorize flow for a client with the given accessMode. An unknown
 * or missing mode is treated as "open" (fail-safe to current behaviour) — only the explicit "testers"/"disabled"
 * values gate.
 */
export async function checkClientAccess(
  accessMode: string | null | undefined,
  userId: number
): Promise<ClientAccessResult> {
  if (accessMode === 'disabled') return { allowed: false, reason: 'disabled' };
  if (accessMode === 'testers') {
    return (await userHasRole(userId, TESTER_ROLE))
      ? { allowed: true }
      : { allowed: false, reason: 'not_tester' };
  }
  return { allowed: true };
}
