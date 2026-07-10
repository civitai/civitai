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
import { CASH_SETTLED_ALIASES, TransactionType } from '~/shared/constants/buzz.constants';
import {
  creatorCompAmountPaidCounter,
  creatorCompCreatorsPaidCounter,
  licenseFeeAmountPaidCounter,
  licenseFeeCreatorsPaidCounter,
} from '~/server/prom/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('creator-compensation', 'green');

export const updateCreatorResourceCompensation = createJob(
  'deliver-creator-compensation',
  '0 2 * * *', // Run 2:00 AM UTC daily
  async () => {
    if (!clickhouse) {
      log('ClickHouse not available, skipping job');
      return;
    }

    // If it's a new day, we need to run the compensation payout job
    const [lastPayout, setLastPayout] = await getJobDate(
      'run-daily-compensation-payout',
      new Date()
    );
    const shouldPayout = dayjs(lastPayout).isBefore(dayjs().startOf('day'));
    if (!shouldPayout) {
      log('Payout already ran today, skipping');
      return;
    }

    try {
      await runPayout(lastPayout);
      await setLastPayout();
      log('Updated last payout date');

      try {
        await clickhouse.$query`
          INSERT INTO kafka.manual_events VALUES
            (now(), 'update-compensation', '{"date":"${formatDate(lastPayout, 'YYYY-MM-DD')}"}');
        `;
        log('Queued compensation update event to Kafka');
      } catch (error) {
        log('Error queueing compensation update event to Kafka:', error);
      }
    } catch (error) {
      log('❌ Payout failed:', error);
      throw error;
    }
  }
);

type UserVersions = { userId: number; modelVersionIds: number[] };
// Orchestrator ships PascalCase accountType (e.g. 'Yellow', 'CashSettled'); the
// buzz API tolerates the aliases so we forward them as-is and only branch on
// cashSettled below for the pennies conversion.
type ResourceRow = {
  modelVersionId: number;
  amount: number;
  accountType: BuzzAccountType;
  source: 'tip' | 'compensation' | 'licenseFee';
};

const BATCH_SIZE = 100;
const COMP_START_DATE = new Date('2024-08-01');

export async function runPayout(lastUpdate: Date) {
  if (!clickhouse) {
    log('ClickHouse not available, skipping payout');
    return;
  }
  if (lastUpdate < COMP_START_DATE) {
    log('Last update before compensation start date, skipping payout');
    return;
  }

  const date = dayjs.utc(lastUpdate).startOf('day').toDate();
  const dateStr = formatDate(date, 'YYYY-MM-DD', true);
  log(`Starting payout process for date: ${dateStr} (${formatDate(date, 'MMM D, YYYY', true)})`);

  const rows = await clickhouse.$query<ResourceRow>`
    SELECT
      modelVersionId,
	    accountType,
	    source,
	    SUM(amount) AS amount
    FROM orchestration.resourceCompensations
    WHERE date = ${date}
    GROUP BY modelVersionId, accountType, source
    HAVING amount > 0;
  `;

  log(`Found ${rows.length} resource compensation rows from ClickHouse`);

  if (!rows.length) {
    log('No compensations found, skipping payout');
    return;
  }

  const creatorsToPay: Record<number, ResourceRow[]> = {};
  const batches = chunk(rows, BATCH_SIZE);
  log(`Processing ${batches.length} batches (batch size: ${BATCH_SIZE})`);

  for (const batch of batches) {
    const versionIds = batch.map((r) => r.modelVersionId);
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
        ...batch.filter((r) => modelVersionIds.includes(r.modelVersionId))
      );
    }
  }

  const creatorCount = Object.keys(creatorsToPay).length;
  log(`Mapped rows to ${creatorCount} creators`);

  if (isEmpty(creatorsToPay)) {
    log('No creators to pay after mapping, skipping payout');
    return;
  }

  // cashSettled rows arrive in tenths-of-a-penny; the cashSettled account
  // ledger uses pennies, so we divide by 10 before minting.
  const transactions = Object.entries(creatorsToPay)
    .flatMap(([userIdStr, userRows]) => {
      const userId = Number(userIdStr);
      const compTotals: Partial<Record<BuzzAccountType, number>> = {};
      const licenseTotals: Partial<Record<BuzzAccountType, number>> = {};

      for (const row of userRows) {
        const bucket = row.source === 'licenseFee' ? licenseTotals : compTotals;
        const isCash = CASH_SETTLED_ALIASES.has(row.accountType);
        const amount =
          row.source === 'licenseFee' && isCash ? Math.floor(row.amount / 10) : row.amount;
        bucket[row.accountType] = (bucket[row.accountType] || 0) + amount;
      }

      const compTx = Object.entries(compTotals).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: userId,
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        // Sum-then-floor once at the daily boundary (amounts arrive fractional from the query now that we no
        // longer floor per row — required so sub-buzz license fees accumulate instead of flooring to 0).
        // No-op for already-integer comp/tip amounts.
        amount: Math.floor(amount),
        description: `Creator tip compensation (${formatDate(date, 'MMM D, YYYY', true)})`,
        type: TransactionType.Compensation,
        externalTransactionId: `creator-tip-comp-${dateStr}-${userId}-${accountType}`,
        source: 'compensation' as const,
      }));

      const licenseTx = Object.entries(licenseTotals).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: userId,
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        // Fractional per-image fees (0.01/image, A2) accumulate across the day; settle the buzz total at
        // this daily boundary by flooring. Sub-buzz remainder is dropped, not carried. FINANCE REVIEW: confirm
        // floor vs round, and whether the sub-buzz remainder should roll over instead of being forfeited.
        amount: Math.floor(amount),
        description: `License fee payout (${formatDate(date, 'MMM D, YYYY', true)})`,
        type: TransactionType.LicenseFee,
        externalTransactionId: `license-fee-${dateStr}-${userId}-${accountType}`,
        source: 'licenseFee' as const,
      }));

      return [...compTx, ...licenseTx];
    })
    .filter((tx) => tx.amount > 0);

  log(`Sample tx: ${transactions[0]?.externalTransactionId}`);

  const totalBuzz = transactions.reduce((sum, tx) => sum + tx.amount, 0);
  log(`Created ${transactions.length} transactions totaling ${totalBuzz}`);

  // Strip the local `source` discriminator before handing rows off to the
  // buzz service — `createBuzzTransactionMany` doesn't accept extra keys.
  const txBatches = chunk(transactions, BATCH_SIZE);
  log(`Processing ${txBatches.length} transaction batches (concurrency: 2)`);

  let processedBatches = 0;
  const tasks = [
    ...txBatches.map((batch) => async () => {
      const payload = batch.map(({ source: _source, ...tx }) => tx);
      await withRetries(() => createBuzzTransactionMany(payload), 1);
      processedBatches++;
      log(`Processed batch ${processedBatches}/${txBatches.length} (${batch.length} transactions)`);

      // Track metrics per (source, accountType) so license payouts surface
      // in their own counter without having to demux later.
      const batchStats = batch.reduce(
        (acc, tx) => {
          const key = `${tx.source}:${tx.toAccountType}`;
          if (!acc[key]) {
            acc[key] = {
              source: tx.source,
              accountType: tx.toAccountType,
              creators: new Set<number>(),
              amount: 0,
            };
          }
          acc[key].creators.add(tx.toAccountId);
          acc[key].amount += tx.amount;
          return acc;
        },
        {} as Record<
          string,
          {
            source: 'compensation' | 'licenseFee';
            accountType: BuzzAccountType;
            creators: Set<number>;
            amount: number;
          }
        >
      );

      Object.values(batchStats).forEach(({ source, accountType, creators, amount }) => {
        if (source === 'licenseFee') {
          licenseFeeCreatorsPaidCounter.inc({ account_type: accountType }, creators.size);
          licenseFeeAmountPaidCounter.inc({ account_type: accountType }, amount);
        } else {
          creatorCompCreatorsPaidCounter.inc({ account_type: accountType }, creators.size);
          creatorCompAmountPaidCounter.inc({ account_type: accountType }, amount);
        }
      });
    }),
  ];

  await limitConcurrency(tasks, 2);

  log(`✅ Payout completed successfully: ${creatorCount} creators paid ${totalBuzz}`);
}
