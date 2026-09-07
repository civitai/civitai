import { chunk } from 'lodash-es';
import { v4 as uuid } from 'uuid';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { userMultipliersCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const REPORT_SAMPLE_SIZE = 25;

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

    const matched = buildTypePredicate(abuseLimits);
    const excludedIps = abuseLimits.excludedIps.map((ip) => `'${ip}'`);
    const clusterCeiling =
      abuseLimits.max_user_count !== undefined
        ? `AND user_count <= ${abuseLimits.max_user_count}`
        : '';

    // Exclusivity has to count the users the type filter would have hidden, which costs a
    // whole-day scan — so it moves the filter out of the WHERE only when it is switched on.
    const exclusivity = abuseLimits.require_exclusive_ip
      ? {
          where: '',
          select: `uniqIf(be.toUserId, ${matched}) as user_count, uniq(be.toUserId) as ip_user_count, sumIf(awardAmount, ${matched}) as awarded`,
          having: 'AND ip_user_count = user_count',
        }
      : {
          where: `AND ${matched}`,
          select: `uniq(be.toUserId) as user_count, sum(awardAmount) as awarded`,
          having: '',
        };

    const abusers = await clickhouse?.$query<Abuser>(`
      SELECT
        ip,
        ${exclusivity.select},
        array_agg(distinct be.toUserId) as user_ids
      FROM buzzEvents be
      WHERE createdDate > subtractDays(now(), 1)
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

    if (abuseLimits.mode === 'report') {
      return {
        mode: 'report' as const,
        usersDisabled: 0,
        wouldDisable: usersToDisable.length,
        ipsFlagged: abusers?.length ?? 0,
        sample:
          abusers?.slice(0, REPORT_SAMPLE_SIZE).map(({ ip, user_count, awarded, user_ids }) => ({
            ip,
            user_count,
            awarded,
            user_ids,
          })) ?? [],
      };
    }

    let usersDisabled = 0;
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
      usersDisabled += affected.length;
    });
    await limitConcurrency(tasks, 3);

    return {
      usersDisabled,
    };
  }
);

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

const abuseLimitsSchema = z.object({
  awarded: z.number().default(3000),
  user_count: z.number().default(10),
  max_user_count: z.number().optional(),
  require_exclusive_ip: z.boolean().default(false),
  mode: z.enum(['enforce', 'report']).default('enforce'),
  excludedIps: sqlSafeToken.array().default(['1.1.1.1', '']), // "10.124.0.14","10.124.0.17","10.124.0.32","10.124.0.70","10.124.0.84","10.124.0.94"
  award_types: sqlSafeToken.array().default(['dailyBoost']),
  award_type_prefixes: sqlSafeToken.array().default([]),
  user_conditions: z.string().array().optional(),
});

type AbuseLimits = z.infer<typeof abuseLimitsSchema>;
