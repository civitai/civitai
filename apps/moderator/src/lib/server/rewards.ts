import { clampBuzzEventMultiplier } from '@civitai/clickhouse';
import { keyHashSlot, REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { sql } from 'kysely';
import { getClickhouse } from './clickhouse';
import { getRedis } from './redis';
import { dbRead } from './db';
import { logAxiomError, logToAxiom } from './axiom';
import { SYSTEM_USER_ID } from './users.service';
import { foldRewardsMultipliers, type UserMultiplierRow } from './user-multipliers';

const MAX_GLOBAL_BONUS = 5;

// Must equal reportAccepted.reward.ts's award, or the shared process-rewards cron grants inconsistently.
const REPORT_ACCEPTED_AWARD = 50;

// `reportAccepted` is a processable reward: writing a `pending` buzzEvents row is the whole action — the
// main-app process-rewards cron reads pending rows (from any app), caps per reporter, and grants the buzz.
export async function rewardReportReporters(input: {
  reportId: number;
  reporterIds: number[];
  /** Reporters the report itself marks as earning nothing for it (`reportersWithoutReward`). */
  unpaidReporterIds?: number[];
  ip?: string;
}): Promise<void> {
  if (!input.reporterIds.length) return;
  try {
    const globalBonus = await getGlobalRewardsBonus();
    const ineligible = await getIneligibleReporters(input.reporterIds);
    for (const id of input.unpaidReporterIds ?? []) ineligible.add(id);
    const { tiers, error: tierError } = await getBaseRewardsMultipliers(
      input.reporterIds.filter((id) => !ineligible.has(id))
    );
    const skipped = input.reporterIds.filter((id) => !ineligible.has(id) && !tiers.has(id));
    if (skipped.length) {
      // Paying these at 1x would underpay any member among them with no trace. Nothing retries a
      // skipped row yet, so this line is what a backfill finds them by.
      logAxiomError(tierError, {
        event: 'reportAccepted reward skipped: multiplier unavailable',
        payload: { retryable: true },
        reportId: input.reportId,
        reporterIds: skipped,
      });
    }
    const clamped: number[] = [];
    const floored: number[] = [];
    const rows = input.reporterIds
      .filter((id) => !skipped.includes(id))
      .map((reporterId) => {
        const base = ineligible.has(reporterId) ? 0 : (tiers.get(reporterId) as number);
        const raw = base * globalBonus;
        const multiplier = clampBuzzEventMultiplier(raw);
        // Both factors are finite, but their PRODUCT need not be: a cached tier near Number.MAX_VALUE
        // times the bonus overflows to Infinity, which the clamp turns into the base multiplier.
        // That is a fallback, not an overflow of the column, and reporting it as a clamp writes
        // `{"multiplierRaw":null}` as the audit trail and fires an alert naming a ceiling nothing hit.
        const adjusted = Number.isFinite(raw) && multiplier !== raw;
        // Split by direction rather than re-testing the ceiling, so this cannot drift from the helper.
        const clampedHigh = adjusted && raw > 0;
        // Not gated on `adjusted`: every negative floors, including -Infinity, which is not finite
        // and would otherwise floor to 0 with no signal at all.
        const flooredLow = raw < 0;
        if (clampedHigh) clamped.push(raw);
        if (flooredLow) floored.push(raw);
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
          // The raw product is kept so an adjusted row stays traceable to the tier and bonus that
          // produced it. Only a finite one: JSON.stringify turns +/-Infinity into `null`.
          transactionDetails:
            (clampedHigh || flooredLow) && Number.isFinite(raw)
              ? JSON.stringify({ multiplierRaw: raw })
              : '{}',
          ...(input.ip && input.ip !== '::1' ? { ip: input.ip } : {}),
        };
      });
    if (floored.length) {
      const finiteFloored = floored.filter(Number.isFinite);
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Buzz event multiplier was negative and was floored to 0',
        payload: {
          flooredEvents: floored.length,
          batchSize: rows.length,
          // Omitted rather than reported when every floored raw overflowed: `Math.min()` of no
          // arguments is +Infinity, which is the opposite sign of the alert and serializes to `null`.
          ...(finiteFloored.length ? { minRaw: Math.min(...finiteFloored) } : {}),
        },
      });
    }
    if (clamped.length) {
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Buzz event multiplier exceeded the ClickHouse column and was clamped',
        payload: {
          clampedEvents: clamped.length,
          batchSize: rows.length,
          maxRaw: Math.max(...clamped),
        },
      });
    }
    if (!rows.length) return;
    await getClickhouse().insert({ table: 'buzzEvents', values: rows, format: 'JSONEachRow' });
  } catch (err) {
    // Nothing retries this. reports.service marks the report Actioned BEFORE calling here and its
    // guarded UPDATE matches nothing on a second attempt, so a throw means these reporters are
    // never paid and the moderator sees a successful action. That has to leave a trace someone
    // can find, which pod stdout is not.
    logAxiomError(err, {
      event: 'reportAccepted rewards write failed',
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
  const ineligible = new Set(rows.map((row) => row.id));
  // The system account files reports on Civitai's behalf; an accepted one earns nobody Buzz.
  if (userIds.includes(SYSTEM_USER_ID)) ineligible.add(SYSTEM_USER_ID);
  return ineligible;
}

// The tier comes from the shared MULTIPLIERS_FOR_USER cache (populated by the main app), and from
// Postgres for every reporter the cache cannot answer: a miss, a notFound marker, a non-finite value
// or a failed read. A reporter neither source can answer is absent from `tiers`: paying them the
// base 1x instead underpays a member with nothing to show for it.
async function getBaseRewardsMultipliers(
  userIds: number[]
): Promise<{ tiers: Map<number, number>; error?: unknown }> {
  const tiers = new Map<number, number>();
  const unresolved: number[] = [];
  const failedReads: CacheReadFailure[] = [];
  await Promise.all(
    userIds.map(async (userId) => {
      const tier = await readCachedRewardsMultiplier(userId, failedReads);
      if (tier === undefined) unresolved.push(userId);
      else tiers.set(userId, tier);
    })
  );
  if (failedReads.length) {
    // One line per report, not per reporter: a cache outage would otherwise log a line for every
    // reporter on every accept. The key's cluster hash slot identifies the shard.
    logToAxiom({
      name: 'buzz-rewards',
      type: 'error',
      message: 'Rewards multiplier cache read failed; read it from Postgres instead',
      error: failedReads[0].error,
      payload: {
        failedReads: failedReads.length,
        errorClasses: [...new Set(failedReads.map((f) => f.errorClass))],
        slots: [...new Set(failedReads.map((f) => f.slot))],
      },
    });
  }
  if (!unresolved.length) return { tiers };
  try {
    const fromDb = await getRewardsMultipliersFromDb(unresolved);
    // No row means no such user; the main app pays that 1x too.
    for (const userId of unresolved) tiers.set(userId, fromDb.get(userId) ?? 1);
    return { tiers };
  } catch (error) {
    return { tiers, error };
  }
}

type CacheReadFailure = { errorClass: string; error: string; slot: number };

async function readCachedRewardsMultiplier(
  userId: number,
  failedReads: CacheReadFailure[]
): Promise<number | undefined> {
  const key = `${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}` as RedisKeyTemplateCache;
  try {
    const cached = await getRedis().packed.get<{ rewardsMultiplier?: number; notFound?: boolean }>(
      key
    );
    // A multiplier of 0 is the cache reporting rewardsEligibility = 'Ineligible', not a missing
    // value. A truthiness guard here pays an ineligible reporter the full award.
    // Finite, not just `typeof number`: NaN and Infinity are both `'number'` and both reach the
    // Decimal(3, 2) column as values it cannot parse.
    if (cached && !cached.notFound && typeof cached.rewardsMultiplier === 'number') {
      if (Number.isFinite(cached.rewardsMultiplier)) return cached.rewardsMultiplier;
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Cached rewards multiplier was not finite; read it from Postgres instead',
        userId,
      });
    }
  } catch (err) {
    failedReads.push({
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      error: err instanceof Error ? err.message : String(err),
      slot: keyHashSlot(key),
    });
  }
  return undefined;
}

// Port of the main app's userMultipliersCache lookupFn query (src/server/redis/caches.ts) and its
// fold, both pinned to main's by src/server/redis/__tests__/moderator-user-multipliers.parity.test.ts.
async function getRewardsMultipliersFromDb(userIds: number[]): Promise<Map<number, number>> {
  const { rows } = await sql<UserMultiplierRow>`
      SELECT
        u.id as "userId",
        (u."rewardsEligibility" = 'Ineligible'::"RewardsEligibility") as "rewardsIneligible",
        (p.metadata->>'rewardsMultiplier')::float as "rewardsMultiplier",
        (p.metadata->>'purchasesMultiplier')::float as "purchasesMultiplier"
      FROM "User" u
      LEFT JOIN "CustomerSubscription" cs
        ON cs."userId" = u.id AND cs.status IN ('active', 'trialing')
        AND cs."currentPeriodEnd" >= now()
      LEFT JOIN "Product" p ON p.id = cs."productId"
      WHERE u.id IN (${sql.join(userIds)});
    `.execute(dbRead);
  return foldRewardsMultipliers(rows);
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
