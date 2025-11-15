import { chunk, isEmpty } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { createJob, getJobDate } from './job';
import { Prisma } from '@prisma/client';
import { withRetries } from '~/server/utils/errorHandling';
import dayjs from 'dayjs';
import { formatDate } from '~/utils/date-helpers';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { creatorCompCreatorsPaidCounter, creatorCompAmountPaidCounter } from '~/server/prom/client';

export const updateCreatorResourceCompensation = createJob(
  'update-creator-resource-compensation',
  '15 0 * * *', // Run 15 minutes after the hour to ensure jobs from the prior hour are completed
  async () => {
    if (!clickhouse) return;

    // If it's a new day, we need to run the compensation payout job
    const [lastPayout, setLastPayout] = await getJobDate(
      'run-daily-compensation-payout',
      new Date()
    );
    const shouldPayout = dayjs(lastPayout).isBefore(dayjs().startOf('day'));
    if (!shouldPayout) return;

    await runPayout(lastPayout);
    await setLastPayout();
    try {
      await clickhouse.$query`
        INSERT INTO kafka.manual_events VALUES
          (now(), 'update-compensation', '{"date":"${formatDate(lastPayout, 'YYYY-MM-DD')}"}');
      `;
    } catch (error) {
      console.error('Error queueing compensation update event', error);
    }
  }
);

type UserVersions = { userId: number; modelVersionIds: number[] };
type Compensation = { modelVersionId: number; amount: number; accountType: BuzzAccountType };

const BATCH_SIZE = 100;
const COMP_START_DATE = new Date('2024-08-01');

export async function runPayout(lastUpdate: Date) {
  if (!clickhouse) return;
  if (lastUpdate < COMP_START_DATE) return;

  const date = dayjs.utc(lastUpdate).startOf('day').toDate();
  const compensations = await clickhouse.$query<Compensation>`
    SELECT
      modelVersionId,
	    accountType,
	    MAX(FLOOR(amount))::int AS amount
    FROM orchestration.resourceCompensations
    WHERE date = ${date}
    GROUP BY modelVersionId, accountType
    HAVING amount > 0;
  `;
  if (!compensations.length) return;

  const creatorsToPay: Record<number, Compensation[]> = {};
  const batches = chunk(compensations, BATCH_SIZE);
  for (const batch of batches) {
    const versionIds = batch.map((c) => c.modelVersionId);
    if (!versionIds.length) continue;

    const userVersions = await dbRead.$queryRaw<UserVersions[]>`
        SELECT
          m."userId" as "userId",
          array_agg(mv.id::int) as "modelVersionIds"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE mv.id IN (${Prisma.join(versionIds)})
        GROUP BY m."userId";
      `;

    for (const { userId, modelVersionIds } of userVersions) {
      if (!modelVersionIds.length || userId === -1) continue;

      if (!creatorsToPay[userId]) creatorsToPay[userId] = [];

      creatorsToPay[userId].push(
        ...batch.filter((c) => modelVersionIds.includes(c.modelVersionId))
      );
    }
  }
  if (isEmpty(creatorsToPay)) return;

  // Compensations and transactions are now one and the same.
  const compensationTransactions = Object.entries(creatorsToPay)
    .flatMap(([userId, compensations]) => {
      const groupedCompensations = compensations.reduce<Partial<Record<BuzzAccountType, number>>>(
        (acc, c) => {
          acc[c.accountType] = (acc[c.accountType] || 0) + c.amount;
          return acc;
        },
        {}
      );

      return Object.entries(groupedCompensations).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: Number(userId),
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        amount,
        description: `Creator tip compensation (${formatDate(date)})`,
        type: TransactionType.Compensation,
        externalTransactionId: `creator-tip-comp-${formatDate(
          date,
          'YYYY-MM-DD'
        )}-${userId}-${accountType}`,
      }));
    })
    .filter((transaction) => transaction.amount > 0);

  const tasks = [
    ...chunk(compensationTransactions, BATCH_SIZE).map((batch) => async () => {
      await withRetries(() => createBuzzTransactionMany(batch), 1);

      // Track metrics for this batch after successful transaction
      const batchStats = batch.reduce((acc, tx) => {
        const accountType = tx.toAccountType;
        if (!acc[accountType]) {
          acc[accountType] = { creators: new Set<number>(), amount: 0 };
        }
        acc[accountType].creators.add(tx.toAccountId);
        acc[accountType].amount += tx.amount;
        return acc;
      }, {} as Record<BuzzAccountType, { creators: Set<number>; amount: number }>);

      // Record metrics by account type for this batch
      Object.entries(batchStats).forEach(([accountType, stats]) => {
        creatorCompCreatorsPaidCounter.inc({ account_type: accountType }, stats.creators.size);
        creatorCompAmountPaidCounter.inc({ account_type: accountType }, stats.amount);
      });
    }),
  ];

  await limitConcurrency(tasks, 2);
}
