import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getClickhouse } from './clickhouse';
import { getRedis } from './redis';
import { dbRead } from './db';

const MAX_GLOBAL_BONUS = 5;

// Must equal reportAccepted.reward.ts's award, or the shared process-rewards cron grants inconsistently.
const REPORT_ACCEPTED_AWARD = 50;

// `reportAccepted` is a processable reward: writing a `pending` buzzEvents row is the whole action — the
// main-app process-rewards cron reads pending rows (from any app), caps per reporter, and grants the buzz.
export async function rewardReportReporters(input: {
  reportId: number;
  reporterIds: number[];
  ip?: string;
}): Promise<void> {
  if (!input.reporterIds.length) return;
  try {
    const globalBonus = await getGlobalRewardsBonus();
    const rows = await Promise.all(
      input.reporterIds.map(async (reporterId) => {
        const base = await getBaseRewardsMultiplier(reporterId);
        // toUserId === byUserId (an accepted report rewards its reporter); ip omitted for localhost/empty
        // so the ClickHouse column falls back to its '' default.
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

// Reads the shared MULTIPLIERS_FOR_USER cache (populated by the main app); a miss falls back to base 1.
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

// The stored multiplier is ×10 — scale back by /10 and clamp to [1, MAX_GLOBAL_BONUS].
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
