import { clampBuzzEventMultiplier } from '@civitai/clickhouse';
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
        // A value past the column's ceiling is not a rounding problem: the insert is fire-and-forget
        // (`wait_for_async_insert: 0`), so ClickHouse accepts the request and drops the unparseable row
        // afterwards, with nothing raised here. `reportAccepted` is processable, so that row IS the
        // payment — the reporter is never paid rather than merely unaudited.
        const multiplier = clampBuzzEventMultiplier(base * globalBonus);
        // toUserId === byUserId (an accepted report rewards its reporter); ip omitted for localhost/empty
        // so the ClickHouse column falls back to its '' default.
        return {
          type: 'reportAccepted',
          toUserId: reporterId,
          forId: input.reportId,
          byUserId: reporterId,
          awardAmount: REPORT_ACCEPTED_AWARD,
          multiplier,
          status: 'pending',
          // Keep the value we meant to write when the ceiling trimmed it, so a clamped row stays
          // traceable — the main app's own writer records the raw value the same way.
          transactionDetails:
            multiplier === base * globalBonus
              ? '{}'
              : JSON.stringify({ multiplierRaw: base * globalBonus }),
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
    // `foldUserMultipliers` writes 0 for a rewards-ineligible user, and 0 is falsy — a truthiness test
    // here read that decision as a missing value and paid the reporter in full. Test for the absence of
    // a number instead. The main app had the same bug in `sendAward` (ClickUp 868kw9kfk).
    if (cached && !cached.notFound && typeof cached.rewardsMultiplier === 'number')
      return cached.rewardsMultiplier;
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
