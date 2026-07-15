import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getClickhouse } from './clickhouse';
import { getRedis } from './redis';
import { dbRead } from './db';

// Global rewards-bonus cap, mirroring MAX_GLOBAL_BONUS in the main app's buzz.service.
const MAX_GLOBAL_BONUS = 5;

// reportAccepted award — mirrors src/server/rewards/passive/reportAccepted.reward.ts. Must match it so the
// main-app process-rewards cron caps (1500/month/reporter) + grants identically.
const REPORT_ACCEPTED_AWARD = 50;

// Reward the reporters of a report that was just actioned — parity with the main app's bulkSetReportStatus
// reward branch. `reportAccepted` is a *processable* reward: the inline path only writes a `pending`
// buzzEvents row (no money moves); the main-app process-rewards cron reads pending rows — regardless of which
// app wrote them — enforces the per-reporter cap, and grants the buzz. So the spoke rewards reporters simply
// by writing that row. Best-effort: a failure here must never fail the moderation action.
export async function rewardReportReporters(input: {
  reportId: number;
  reporterIds: number[];
  ip?: string;
}): Promise<void> {
  if (!input.reporterIds.length) return;
  try {
    // The bonus event is global, so resolve it once and reuse it for every reporter.
    const globalBonus = await getGlobalRewardsBonus();
    const rows = await Promise.all(
      input.reporterIds.map(async (reporterId) => {
        const base = await getBaseRewardsMultiplier(reporterId);
        // The `buzzEvents` pending row — field set + status + ip/transactionDetails normalization copied from
        // base.reward.ts's inline `apply`. An accepted report rewards the reporter, so toUserId === byUserId
        // (parity with reportAccepted.getKey). ip is omitted for localhost/empty so the CH column falls back
        // to its '' default.
        return {
          type: 'reportAccepted',
          toUserId: reporterId,
          forId: input.reportId,
          byUserId: reporterId,
          awardAmount: REPORT_ACCEPTED_AWARD,
          multiplier: base * globalBonus,
          status: 'pending',
          transactionDetails: '{}',
          ...(input.ip && input.ip !== '::1' ? { ip: input.ip } : {}),
        };
      })
    );
    await getClickhouse().insert({ table: 'buzzEvents', values: rows, format: 'JSONEachRow' });
  } catch (err) {
    console.error('[rewards] failed to record reportAccepted events', err);
  }
}

// Base per-user rewards multiplier (supporter tier), read from the SHARED cache the main app populates
// (createCachedObject at MULTIPLIERS_FOR_USER, one key per user). A cold miss or a `notFound` marker falls
// back to 1 (base user) — the same default getMultipliersForUser uses when the id isn't cached.
async function getBaseRewardsMultiplier(userId: number): Promise<number> {
  try {
    const cached = await getRedis().packed.get<{ rewardsMultiplier?: number; notFound?: boolean }>(
      `${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}` as RedisKeyTemplateCache
    );
    if (cached && !cached.notFound && cached.rewardsMultiplier) return cached.rewardsMultiplier;
  } catch {
    // Shared-cache read is best-effort; fall back to the base multiplier.
  }
  return 1;
}

// Active global rewards-bonus multiplier, mirroring getActiveRewardsBonusEvent + the /10 scaling in
// getMultipliersForUser. Picks the highest-multiplier currently-active enabled event; its stored value
// (multiplier * 10) is scaled back and clamped to [1, MAX_GLOBAL_BONUS].
async function getGlobalRewardsBonus(): Promise<number> {
  const events = await dbRead
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
