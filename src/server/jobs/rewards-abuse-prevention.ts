import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { z } from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
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
      AND be.toUserId = be.byUserId
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
    const tasks = chunk(usersToDisable, 500).map((chunk) => async () => {
      const affected = await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "User"
        SET "rewardsEligibility" = 'Ineligible'::"RewardsEligibility",
            "eligibilityChangedAt" = NOW()
        WHERE "id" IN (${Prisma.join(usersToDisable)})
        AND "rewardsEligibility" != 'Protected'::"RewardsEligibility"
        AND "rewardsEligibility" != 'Ineligible'::"RewardsEligibility"
        RETURNING "id";
      `;

      await userMultipliersCache.bust(affected.map((user) => user.id));
      await createNotification({
        userIds: affected.map((user) => user.id),
        category: 'System',
        type: 'system-announcement',
        details: {
          message: 'Your Buzz rewards have been disabled due to suspicious activity.',
          url: '/user/buzz-dashboard',
        },
      });
    });
    await limitConcurrency(tasks, 3);

    return {
      usersDisabled: usersToDisable.length,
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
});
