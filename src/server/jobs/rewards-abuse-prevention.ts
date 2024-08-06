import { chunk } from 'lodash-es';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { userMultipliersCache } from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const rewardsAbusePrevention = createJob(
  'rewards-abuse-prevention',
  '0 3 * * *',
  async () => {
    const abuseLimits = abuseLimitsSchema.parse(
      JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, 'rewards:abuse-limits')) ?? '{}')
    );
    const abusers = await clickhouse?.$query<Abuser>(`
      SELECT
        ip,
        uniq(be.toUserId) as user_count,
        array_agg(distinct be.toUserId) as user_ids,
        sum(awardAmount) as awarded
      FROM buzzEvents be
      WHERE createdDate > subtractDays(now(), 1)
      AND be.type IN (${abuseLimits.award_types.map((type) => `'${type}'`)})
      AND ip NOT IN (${abuseLimits.excludedIps.map((ip) => `'${ip}'`)})
      AND awardAmount > 0
      GROUP BY ip
      HAVING uniq(be.toUserId) > 1 AND (
        awarded >= ${abuseLimits.awarded} OR
        user_count > ${abuseLimits.user_count}
      )
      ORDER BY awarded DESC;
    `);

    const usersToDisable = abusers?.map((abuser) => abuser.user_ids).flat() ?? [];
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

      await userMultipliersCache.bust(affected.map((user) => user.id));
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

type Abuser = {
  ip: string;
  user_count: number;
  user_ids: number[];
  awarded: number;
};

const abuseLimitsSchema = z.object({
  awarded: z.number().default(3000),
  user_count: z.number().default(10),
  excludedIps: z.string().array().default(['1.1.1.1', '']),
  award_types: z.string().array().default(['dailyBoost']),
  user_conditions: z.string().array().optional(),
});
