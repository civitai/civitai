import { clampBuzzEventMultiplier } from '@civitai/clickhouse';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getClickhouse } from './clickhouse';
import { getRedis } from './redis';
import { dbRead } from './db';
import { logAxiomError, logToAxiom } from './axiom';

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
    const ineligible = await getIneligibleReporters(input.reporterIds);
    const clamped: number[] = [];
    const rows = await Promise.all(
      input.reporterIds.map(async (reporterId) => {
        const base = ineligible.has(reporterId) ? 0 : await getBaseRewardsMultiplier(reporterId);
        const raw = base * globalBonus;
        const multiplier = clampBuzzEventMultiplier(raw);
        // `raw` is non-finite only if the cached tier was garbage, and 1 is then the fallback rather
        // than a clamp — reporting it as one would fire an error alert naming a ceiling nothing hit.
        const wasClamped = Number.isFinite(raw) && multiplier !== raw;
        if (wasClamped) clamped.push(raw);
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
          // The raw product is kept so a clamped row is still traceable back to the tier and bonus
          // that produced it.
          transactionDetails: wasClamped ? JSON.stringify({ multiplierRaw: raw }) : '{}',
          ...(input.ip && input.ip !== '::1' ? { ip: input.ip } : {}),
        };
      })
    );
    if (clamped.length) {
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Buzz event multiplier exceeded the ClickHouse column and was clamped',
        clampedEvents: clamped.length,
        batchSize: rows.length,
        maxRaw: Math.max(...clamped),
      }).catch(() => null);
    }
    await getClickhouse().insert({ table: 'buzzEvents', values: rows, format: 'JSONEachRow' });
  } catch (err) {
    // Nothing retries this. reports.service marks the report Actioned BEFORE calling here and its
    // guarded UPDATE matches nothing on a second attempt, so a throw means these reporters are
    // never paid and the moderator sees a successful action. That has to leave a trace someone
    // can find, which pod stdout is not.
    logAxiomError(err, {
      name: 'buzz-rewards',
      message: 'failed to record reportAccepted events; reporters will not be paid',
      reportId: input.reportId,
      reporterIds: input.reporterIds,
    });
  }
}

// Eligibility is read from Postgres, not from the shared cache. That cache is populated only by the
// main app and expires after a day, so a reporter who has not browsed the site since filing has no
// entry — and a miss there is indistinguishable from eligible. This path is the whole payout: the
// pending row it writes is what process-rewards pays, so the barred user has to be barred here.
async function getIneligibleReporters(userIds: number[]): Promise<Set<number>> {
  const rows = await dbRead
    .selectFrom('User')
    .select(['id'])
    .where('id', 'in', userIds)
    .where('rewardsEligibility', '=', 'Ineligible')
    .execute();
  return new Set(rows.map((row) => row.id));
}

// Reads the shared MULTIPLIERS_FOR_USER cache (populated by the main app) for the TIER only; a miss
// falls back to base 1. Unlike eligibility, a stale tier costs the reporter a multiplier rather than
// paying someone who should earn nothing.
async function getBaseRewardsMultiplier(userId: number): Promise<number> {
  try {
    const cached = await getRedis().packed.get<{ rewardsMultiplier?: number; notFound?: boolean }>(
      `${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}` as RedisKeyTemplateCache
    );
    // A multiplier of 0 is the cache reporting rewardsEligibility = 'Ineligible', not a missing
    // value. Falling through to 1 there paid an ineligible reporter the full award — the same hole
    // PR #4383 closed on the main app's side of this table.
    // Finite, not just `typeof number`: NaN and Infinity are both `'number'` and both reach the
    // Decimal(3, 2) column as values it cannot parse. Rejecting them here rather than letting the
    // clamp catch them is what makes a garbage entry pay the same as a missing one — the clamp
    // never sees `globalBonus`, so falling back there pays 1 where a miss pays 1 x the bonus.
    if (cached && !cached.notFound && typeof cached.rewardsMultiplier === 'number') {
      if (Number.isFinite(cached.rewardsMultiplier)) return cached.rewardsMultiplier;
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Cached rewards multiplier was not finite; paid the base multiplier instead',
        userId,
      }).catch(() => null);
    }
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
