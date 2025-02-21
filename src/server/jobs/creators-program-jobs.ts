import { CacheTTL } from '~/server/common/constants';
import {
  redis,
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  RedisKeyTemplateCache,
  sysRedis,
} from '~/server/redis/client';
import { mergeQueue } from '~/server/redis/queues';
import { refreshBlockedModelHashes } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';
import { dbKV } from '~/server/db/db-helpers';
import {
  CAPPED_BUZZ_VALUE,
  FIRST_CREATOR_PROGRAM_MONTH,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';
import {
  bustCompensationPoolCache,
  flushBankedCache,
  getCompensationPool,
  getPoolParticipants,
  userCapCache,
  userCashCache,
} from '~/server/services/creator-program.service';
import { BuzzTransactionDetails, TransactionType } from '~/server/schema/buzz.schema';
import { withRetries } from '~/server/utils/errorHandling';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import dayjs from 'dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { createTipaltiPayee } from '~/server/services/user-payment-configuration.service';
import { NotificationCategory } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';

export const creatorsProgramDistribute = createJob(
  'creators-program-distribute',
  '2 23 L * *',
  async () => {
    if (!clickhouse) return;

    // Determine `month` we're settling
    let month = await dbKV.get('compensation-pool-month', FIRST_CREATOR_PROGRAM_MONTH);
    month = dayjs(month).startOf('month').toDate();

    // Get pool data
    const pool = await getCompensationPool({ month });

    // Get totals for all participants in bank
    const participants = await getPoolParticipants(month);

    // Allocate pool value based on participant portion
    const allocations: [number, number][] = [];
    let availablePoolValue = Math.floor(pool.value * 100);
    for (const participant of participants) {
      // If we're out of pool value, we're done... (sorry folks)
      if (availablePoolValue <= 0) break;

      // Determine participant share
      const participantPortion = participant.amount / pool.size.current;
      let participantShare = Math.floor(pool.value * participantPortion * 100);
      const perBuzzValue = participantShare / participant.amount;
      // Cap Buzz value
      if (perBuzzValue > CAPPED_BUZZ_VALUE)
        participantShare = participant.amount * CAPPED_BUZZ_VALUE;

      // Set allocation
      allocations.push([participant.userId, participantShare]);
      availablePoolValue -= participantShare;
    }

    // Send pending cash transactions from bank with retry
    const monthStr = dayjs(month).format('YYYY-MM');
    await withRetries(async () => {
      createBuzzTransactionMany(
        allocations.map(([userId, amount]) => ({
          type: TransactionType.Compensation,
          toAccountType: 'cashpending',
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount,
          description: `Compensation pool for ${monthStr}`,
          details: { month },
          externalTransactionId: `comp-pool-${monthStr}-${userId}`,
        }))
      );
    });

    // Send tipalti invite to users with $50+ in cash without a tipalti account
    // TODO creators program: Ask Koen if this data will be settled in clickhouse yet? (I assume not)
    // TODO creators program: Need to revise Koen's API to support multiple users. Otherwise we make 1 request per user.
    const usersOverThreshold = await clickhouse!.$query<{ userId: number; balance: number }>`
      WITH affected AS (
        SELECT DISTINCT toAccountId as id
        FROM buzzTransactions
        WHERE toAccountType = 'cashpending'
        AND date > ${month}
      )
      SELECT
        toAccountId as userId,
        SUM(if(toAccountType = 'cashpending' OR (toAccountType = 'cashsettled' AND fromAccountType != 'cashpending'), amount, 0)) as balance
      FROM buzzTransactions
      WHERE toAccountType IN ('cashpending', 'cashsettled')
        AND toAccountId IN (SELECT id FROM affected)
      GROUP BY toAccountId
      HAVING balance > ${MIN_WITHDRAWAL_AMOUNT};
    `;
    const userIdsOverThreshold = usersOverThreshold.map((u) => u.userId);
    const usersWithTipalti = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT
        "userId"
      FROM "UserPaymentConfiguration" uc
      WHERE "tipaltiAccountId" IS NOT NULL
      AND "userId" IN (${userIdsOverThreshold});
    `;
    const usersWithoutTipalti = userIdsOverThreshold.filter(
      (userId) => !usersWithTipalti.some((u) => u.userId === userId)
    );
    const tasks = usersWithoutTipalti.map((userId) => async () => {
      await createTipaltiPayee({ userId });
    });
    await limitConcurrency(tasks, 5);

    // Bust user caches
    const affectedUsers = participants.map((p) => p.userId);
    userCashCache.bust(affectedUsers);
    // TODO creator program stretch: send signal to update user cash balance

    // Update month
    month = dayjs(month).add(1, 'month').toDate();
    await dbKV.set('compensation-pool-month', month);
  }
);

export const creatorsProgramRollover = createJob(
  'creators-program-rollover',
  '0 0 1 * *',
  async () => {
    await userCapCache.flush();
    await flushBankedCache();
    await bustCompensationPoolCache();
  }
);

export const creatorsProgramSettleCash = createJob(
  'creators-program-settlement',
  '0 0 15 * *',
  async () => {
    if (!clickhouse) return;
    const pendingCash = await clickhouse.$query<{ userId: number; amount: number }>`
      SELECT
        toAccountId as userId,
        SUM(if(toAccountType = 'cashpending', amount, -amount)) as amount
      FROM buzzTransactions
      WHERE (
        -- Settlements
        fromAccountType = 'cashpending'
        AND toAccountType = 'cashsettled'
      ) OR (
        -- Deposits
        fromAccountId = 0
        AND toAccountType = 'cashpending'
      )
      GROUP BY userId
      HAVING amount > 0;
    `;

    // Settle pending cash transactions from bank with retry
    const monthStr = dayjs().format('YYYY-MM');
    await withRetries(async () => {
      createBuzzTransactionMany(
        pendingCash.map(({ userId, amount }) => ({
          type: TransactionType.Compensation,
          toAccountType: 'cashsettled',
          toAccountId: userId,
          fromAccountType: 'cashpending',
          fromAccountId: userId,
          amount,
          description: `Cash settlement for ${monthStr}`,
          externalTransactionId: `settlement-${monthStr}-${userId}`,
        }))
      );
    });

    // Bust user caches
    const affectedUsers = pendingCash.map((p) => p.userId);
    userCashCache.bust(affectedUsers);
    // TODO creator program stretch: send signal to update user cash balance
  }
);

export const creatorProgramJobs = [
  creatorsProgramDistribute,
  creatorsProgramRollover,
  creatorsProgramSettleCash,
];
