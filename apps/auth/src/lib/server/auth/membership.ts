import { db } from '../db/db';
import { invalidateSessionUser } from './session-producer';

/** Tiers an override may grant. Mirrors the main app's `userTiers` minus `free` (a "free override" is a no-op). */
export const OVERRIDE_TIERS = ['bronze', 'silver', 'gold', 'founder'] as const;
export type OverrideTier = (typeof OVERRIDE_TIERS)[number];

export function isOverrideTier(value: string): value is OverrideTier {
  return (OVERRIDE_TIERS as readonly string[]).includes(value);
}

export function listOverrides() {
  return db
    .selectFrom('UserMembershipOverride as o')
    .innerJoin('User', 'User.id', 'o.userId')
    .leftJoin('User as granter', 'granter.id', 'o.grantedById')
    .select([
      'o.userId',
      'o.tier',
      'o.note',
      'o.createdAt',
      'User.username',
      'granter.username as grantedByUsername',
    ])
    .orderBy('o.createdAt', 'desc')
    .execute();
}

function resolveUser(raw: string) {
  return /^\d+$/.test(raw)
    ? db.selectFrom('User').select(['id', 'username']).where('id', '=', Number(raw)).executeTakeFirst()
    : db.selectFrom('User').select(['id', 'username']).where('username', 'ilike', raw).executeTakeFirst();
}

// The override rides on the produced session, so every write busts the shared session cache — otherwise the
// user keeps their old tier for up to the 4h TTL.
export async function setOverride(
  userRaw: string,
  tier: OverrideTier,
  note: string | null,
  grantedById: number | null
) {
  const user = await resolveUser(userRaw);
  if (!user) return { ok: false as const, error: `No user found for "${userRaw}".` };

  await db
    .insertInto('UserMembershipOverride')
    .values({ userId: user.id, tier, note, grantedById, updatedAt: new Date() })
    .onConflict((oc) =>
      oc.column('userId').doUpdateSet({ tier, note, grantedById, updatedAt: new Date() })
    )
    .execute();

  await invalidateSessionUser(user.id);
  return { ok: true as const, user };
}

export async function removeOverride(userId: number) {
  await db.deleteFrom('UserMembershipOverride').where('userId', '=', userId).execute();
  await invalidateSessionUser(userId);
}
