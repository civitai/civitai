import { type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Global rewards-bonus cap, mirroring MAX_GLOBAL_BONUS in the main app's buzz.service.
const MAX_GLOBAL_BONUS = 5;

// Active global rewards-bonus multiplier, mirroring getActiveRewardsBonusEvent + the /10 scaling in
// getMultipliersForUser. Picks the highest-multiplier currently-active enabled event; its stored value
// (multiplier * 10) is scaled back and clamped to [1, MAX_GLOBAL_BONUS].
export async function getGlobalRewardsBonus(db: Kysely<DB>): Promise<number> {
  const events = await db
    .selectFrom('RewardsBonusEvent')
    .select(['multiplier', 'startsAt', 'endsAt'])
    .where('enabled', '=', true)
    .execute();
  const now = new Date();
  const active = events.filter(
    (e) => (!e.startsAt || e.startsAt <= now) && (!e.endsAt || e.endsAt >= now)
  );
  if (!active.length) return 1;
  const raw = Math.max(...active.map((e) => e.multiplier)) / 10;
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_GLOBAL_BONUS) : 1;
}
