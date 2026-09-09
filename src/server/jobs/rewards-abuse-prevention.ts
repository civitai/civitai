import { chunk } from 'lodash-es';
import { v4 as uuid } from 'uuid';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { resolveDatabaseEnvironment } from '~/env/database-target';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { userMultipliersCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const REPORT_SAMPLE_SIZE = 25;

// `createdDate` is MATERIALIZED, so it prunes no partitions and the scan reads the whole table.
// `time` is what the partition key is built from; a bound wide enough to sit outside the
// createdDate window prunes without being able to change which rows match.
const DATE_BOUND_SLACK_DAYS = 3;

// The clustering day is the previous COMPLETE one. `createdDate > subtractDays(now(), 1)` reads
// as "the last 24 hours" and is not: `createdDate` is a Date, so the comparison happens at
// midnight and the predicate collapses to "today" — three hours of data at the 03:00 cron, against
// thresholds that only make sense over a day. Fixing the day to yesterday also makes a run
// reproducible, since what it sees no longer depends on the hour it fired.

export const rewardsAbusePrevention = createJob(
  'rewards-abuse-prevention',
  '0 3 * * *',
  async () => {
    let abuseLimitsRaw: string | Buffer | null = null;
    try {
      abuseLimitsRaw = await withSysReadDeadline(
        sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'rewards:abuse-limits')
      );
    } catch {
      // sysRedis DOWN/SLOW — we can't read the abuse thresholds. This job DISABLES
      // user rewards (destructive), so skip this cycle rather than run on unknown
      // config. The nightly cron retries tomorrow; a missed run is harmless.
      return { usersDisabled: 0, skipped: 'sysRedis-config-read-failed' };
    }
    // Buffer-coerce (sentinel-mode sysRedis returns Buffer for BLOB_STRING replies;
    // `?? '{}'` alone would mis-handle a Buffer — same root cause as base.metrics).
    const abuseLimits = abuseLimitsSchema.parse(
      JSON.parse(
        (Buffer.isBuffer(abuseLimitsRaw) ? abuseLimitsRaw.toString('utf8') : abuseLimitsRaw) ?? '{}'
      )
    );

    const typePredicate = buildTypePredicate(abuseLimits);
    const persistence = buildPersistenceGate(abuseLimits, typePredicate);
    const matched = persistence.condition
      ? `${typePredicate} AND ${persistence.condition}`
      : typePredicate;
    const excludedIps = abuseLimits.excludedIps.map((ip) => `'${ip}'`);

    // Both non-default branches keep a filter out of the WHERE so `ip_user_count` can see the
    // users it would have hidden, which costs a whole-day scan — hence only when one is on.
    //
    // `uniqExact` in the exclusivity branch only: its having-clause compares the two counts for
    // EQUALITY, and that is unstable between two HyperLogLog estimates.
    //
    // `user_ids` drives the disable write, so it is gated in every branch rather than relying on
    // the exclusivity equality to make the two sets coincide.
    //
    // `max_user_count` is the one threshold that is an UPPER bound, so it has to read a count the
    // persistence gate cannot shrink: gating the column the ceiling compares lets an IP too large
    // to be a farm slip under it.
    const exclusivity = abuseLimits.require_exclusive_ip
      ? {
          where: '',
          select: `uniqExactIf(be.toUserId, ${matched}) as user_count, uniqExact(be.toUserId) as ip_user_count, sumIf(awardAmount, ${matched}) as awarded, groupUniqArrayIf(be.toUserId, ${matched}) as user_ids`,
          having: 'AND ip_user_count = user_count',
          ceiling: 'ip_user_count',
        }
      : persistence.condition
      ? {
          where: `AND ${typePredicate}`,
          select: `uniqIf(be.toUserId, ${persistence.condition}) as user_count, uniq(be.toUserId) as ip_user_count, sumIf(awardAmount, ${persistence.condition}) as awarded, groupUniqArrayIf(be.toUserId, ${persistence.condition}) as user_ids`,
          having: '',
          ceiling: 'ip_user_count',
        }
      : {
          where: `AND ${matched}`,
          select: `uniq(be.toUserId) as user_count, sum(awardAmount) as awarded, array_agg(distinct be.toUserId) as user_ids`,
          having: '',
          ceiling: 'user_count',
        };

    const clusterCeiling =
      abuseLimits.max_user_count !== undefined
        ? `AND ${exclusivity.ceiling} <= ${abuseLimits.max_user_count}`
        : '';

    const abusers = await clickhouse?.$query<Abuser>(`
      ${persistence.cte}
      SELECT
        ip,
        ${exclusivity.select}
      FROM buzzEvents be
      WHERE createdDate = subtractDays(toDate(now()), 1)
      AND time > subtractDays(now(), ${DATE_BOUND_SLACK_DAYS})
      ${exclusivity.where}
      AND ip NOT IN (${excludedIps})
      AND awardAmount > 0
      GROUP BY ip
      HAVING user_count > 1 AND (
        awarded >= ${abuseLimits.awarded} AND
        user_count > ${abuseLimits.user_count}
      )
      ${clusterCeiling}
      ${exclusivity.having}
      ORDER BY awarded DESC;
    `);

    const usersToDisable = abusers?.map((abuser) => abuser.user_ids).flat() ?? [];

    // What it found, reported the same way whether or not it acted on it. A live run that disables
    // nobody is otherwise indistinguishable from a run that found nothing.
    const found = {
      dryRun: abuseLimits.dryRun,
      minCapDays: abuseLimits.min_cap_days,
      wouldDisable: new Set(usersToDisable).size,
      ipsFlagged: abusers?.length ?? 0,
      sample:
        abusers?.slice(0, REPORT_SAMPLE_SIZE).map(({ ip, user_count, awarded, user_ids }) => ({
          ip,
          user_count,
          awarded,
          user_ids,
        })) ?? [],
    };

    const runId = uuid();

    if (abuseLimits.dryRun) {
      await logDecisions({ runId, abusers, abuseLimits, disabled: new Set(), usersDisabled: 0 });
      return { ...found, usersDisabled: 0 };
    }

    let usersDisabled = 0;
    const disabled = new Set<number>();
    const tasks = chunk(usersToDisable, 500).map((chunk) => async () => {
      const affected = await dbWrite.$queryRawUnsafe<{ id: number }[]>(`
        UPDATE "User" u
        SET "rewardsEligibility" = 'Ineligible'::"RewardsEligibility",
            "eligibilityChangedAt" = NOW()
        WHERE "id" IN (${chunk.join(',')})
        AND "rewardsEligibility" != 'Protected'::"RewardsEligibility"
        AND "rewardsEligibility" != 'Ineligible'::"RewardsEligibility"
        ${abuseLimits.user_conditions ? `AND ${abuseLimits.user_conditions.join(' AND ')}` : ''}
        RETURNING "id";
      `);

      const { userUpdateCounter } = await import('~/server/prom/client');
      if (affected.length > 0) {
        userUpdateCounter?.inc({ location: 'job:rewards-abuse-prevention' }, affected.length);
      }

      await userMultipliersCache.refresh(affected.map((user) => user.id));
      await createNotification({
        userIds: affected.map((user) => user.id),
        category: NotificationCategory.System,
        type: 'system-announcement',
        key: `system-announcement:rewards:${uuid()}`,
        details: {
          message: 'Your Buzz rewards have been disabled due to suspicious activity.',
          url: '/articles/5799',
        },
      });
      for (const user of affected) disabled.add(user.id);
      usersDisabled += affected.length;
    });
    await limitConcurrency(tasks, 3);

    await logDecisions({ runId, abusers, abuseLimits, disabled, usersDisabled });

    return { ...found, usersDisabled };
  }
);

/**
 * One row per flagged IP, plus the config that flagged it, so reviewing a threshold is a query
 * rather than a re-run against live data.
 *
 * Never throws. The accounts have already been disabled by the time this runs, and losing the
 * audit trail is worse than losing it silently is bad — but failing the job here would leave the
 * database changed and the run reported as failed, which is the worse of the two.
 */
async function logDecisions({
  runId,
  abusers,
  abuseLimits,
  disabled,
  usersDisabled,
}: {
  runId: string;
  abusers: Abuser[] | undefined;
  abuseLimits: AbuseLimits;
  disabled: Set<number>;
  usersDisabled: number;
}) {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const config = {
    env: resolveDatabaseEnvironment(),
    dryRun: abuseLimits.dryRun ? 1 : 0,
    awardTypes: abuseLimits.award_types,
    awardTypePrefixes: abuseLimits.award_type_prefixes,
    awardedThreshold: abuseLimits.awarded,
    userCountThreshold: abuseLimits.user_count,
    maxUserCount: abuseLimits.max_user_count ?? null,
    requireExclusiveIp: abuseLimits.require_exclusive_ip ? 1 : 0,
    config: JSON.stringify(abuseLimits),
  };

  const rows = (abusers ?? []).map((abuser) => ({
    time,
    runId,
    ...config,
    ip: abuser.ip,
    userIds: abuser.user_ids,
    userCount: abuser.user_count,
    ipUserCount: abuser.ip_user_count ?? abuser.user_count,
    awarded: abuser.awarded,
    disabledUserIds: abuser.user_ids.filter((id) => disabled.has(id)),
    usersDisabled,
  }));

  // A run that flagged nothing still writes one row, with an empty `ip`. Without it, a quiet
  // night and a night the job never ran are the same absence — the shape that hid a 79-hour
  // outage in auto-feature-images.
  if (!rows.length)
    rows.push({
      time,
      runId,
      ...config,
      ip: '',
      userIds: [],
      userCount: 0,
      ipUserCount: 0,
      awarded: 0,
      disabledUserIds: [],
      usersDisabled: 0,
    });

  try {
    await clickhouse?.insert({
      table: 'rewards_abuse_decisions',
      values: rows,
      format: 'JSONEachRow',
    });
  } catch (error) {
    const { logToAxiom } = await import('~/server/logging/client');
    logToAxiom(
      {
        type: 'error',
        name: 'rewards-abuse-decisions-log-failed',
        message: (error as Error)?.message,
        runId,
        rows: rows.length,
      },
      'webhooks'
    ).catch(() => null);
  }
}

/**
 * Sharing an IP says nothing about the person: a household reproduces the cluster shape exactly.
 * This asks the separate question — does this ACCOUNT peg its own daily cap habitually — and
 * every account has its own cap, so the IP's total cannot answer it.
 *
 *
 * The window is `cap_days_window` COMPLETE days ending on the clustering day, for the same reason
 * that day is fixed rather than rolling — see the note on DATE_BOUND_SLACK_DAYS.
 *
 * A cap-day compares the day against the account's OWN ceiling, both sides multiplied: a member
 * on a 1.5x multiplier is capped at 150, so being paid 100 is not a cap-day. `awardAmount` carries
 * the base award except on the one grant a day the cap trims, which stores the multiplied value
 * and neutralises `multiplier` to 1.
 */
function buildPersistenceGate(abuseLimits: AbuseLimits, typePredicate: string) {
  const { cap_days_window: window, cap_day_awarded: cap, min_cap_days: minCapDays } = abuseLimits;
  if (!minCapDays || cap === undefined) return { cte: '', condition: '' };

  return {
    cte: `WITH persistent_earners AS (
        SELECT toUserId AS uid
        FROM (
          SELECT be.toUserId AS toUserId, be.createdDate AS day,
            sum(if(be.multiplier = 1, be.awardAmount, ceil(be.awardAmount * be.multiplier))) AS day_awarded,
            ceil(${cap} * max(be.multiplier)) AS day_cap
          FROM buzzEvents be
          WHERE createdDate BETWEEN subtractDays(toDate(now()), ${window}) AND subtractDays(toDate(now()), 1)
          AND time > subtractDays(now(), ${window + DATE_BOUND_SLACK_DAYS})
          AND ${typePredicate}
          AND awardAmount > 0
          GROUP BY toUserId, day
        )
        GROUP BY uid
        HAVING countIf(day_awarded >= day_cap) >= ${minCapDays}
      )`,
    condition: 'be.toUserId IN (SELECT uid FROM persistent_earners)',
  };
}

// `encouragement` writes one buzzEvent type per entity kind (`encouragement:image`,
// `:comment`, `:article`, …), so an exact-match list silently stops covering the family
// the next time an entity kind is added.
function buildTypePredicate({ award_types, award_type_prefixes }: AbuseLimits) {
  const clauses: string[] = [];
  if (award_types.length)
    clauses.push(`be.type IN (${award_types.map((type) => `'${type}'`).join(',')})`);
  for (const prefix of award_type_prefixes) clauses.push(`startsWith(be.type, '${prefix}')`);

  if (!clauses.length) return '1 = 0';
  if (clauses.length === 1) return clauses[0];
  return `(${clauses.join(' OR ')})`;
}

type Abuser = {
  ip: string;
  user_count: number;
  ip_user_count?: number;
  user_ids: number[];
  awarded: number;
};

// Interpolated into SQL. Operator-authored rather than user input, but a stray quote takes
// the nightly run down unattended.
const sqlSafeToken = z
  .string()
  .regex(/^[A-Za-z0-9_:.-]*$/, 'must not contain SQL-significant characters');

const abuseLimitsSchema = z
  .object({
    awarded: z.number().default(3000),
    user_count: z.number().default(10),
    max_user_count: z.number().optional(),
    require_exclusive_ip: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    excludedIps: sqlSafeToken.array().default(['1.1.1.1', '']), // "10.124.0.14","10.124.0.17","10.124.0.32","10.124.0.70","10.124.0.84","10.124.0.94"
    award_types: sqlSafeToken.array().default(['dailyBoost']),
    award_type_prefixes: sqlSafeToken.array().default([]),
    min_cap_days: z.number().int().nonnegative().default(0),
    // Bounded so a mistyped window fails validation rather than the nightly run; past ~90 days
    // the aggregate outruns the page cache.
    cap_days_window: z.number().int().positive().max(365).default(30),
    // No default on purpose: `award_types` defaults to dailyBoost, capped at 25, so a borrowed
    // 100 builds a gate nobody passes and reports it as a quiet night. The enforced cap is in
    // `rewards:config`.
    cap_day_awarded: z.number().int().positive().optional(),
    user_conditions: z.string().array().optional(),
  })
  .superRefine((limits, ctx) => {
    if (limits.min_cap_days > 0 && limits.cap_day_awarded === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['cap_day_awarded'],
        message: 'cap_day_awarded is required when min_cap_days is set',
      });
  });

type AbuseLimits = z.infer<typeof abuseLimitsSchema>;
