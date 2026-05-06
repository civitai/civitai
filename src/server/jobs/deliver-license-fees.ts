import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { chunk, isEmpty } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import {
  licenseFeeAmountPaidCounter,
  licenseFeeCreatorsPaidCounter,
} from '~/server/prom/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { formatDate } from '~/utils/date-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate } from './job';

const log = createLogger('license-fees', 'green');

export const deliverLicenseFees = createJob(
  'deliver-license-fees',
  '0 3 * * *', // 3:00 AM UTC daily — staggered after creator-comp at 2:00.
  async () => {
    if (!clickhouse) {
      log('ClickHouse not available, skipping job');
      return;
    }

    const [lastPayout, setLastPayout] = await getJobDate(
      'run-daily-license-fee-payout',
      new Date()
    );
    const shouldPayout = dayjs(lastPayout).isBefore(dayjs().startOf('day'));
    if (!shouldPayout) {
      log('Payout already ran today, skipping');
      return;
    }

    try {
      await runLicenseFeePayout(lastPayout);
      await setLastPayout();
      log('Updated last payout date');
    } catch (error) {
      log('❌ Payout failed:', error);
      throw error;
    }
  }
);

type UserVersions = { userId: number; modelVersionIds: number[] };
type LicenseFeeRow = {
  modelVersionId: number;
  amount: number;
  accountType: BuzzAccountType;
};

const BATCH_SIZE = 100;
// Phase 1 ships with Anima, no historical license rows before this date.
const LICENSE_FEE_START_DATE = new Date('2026-05-01');

export async function runLicenseFeePayout(lastUpdate: Date) {
  if (!clickhouse) {
    log('ClickHouse not available, skipping payout');
    return;
  }
  if (lastUpdate < LICENSE_FEE_START_DATE) {
    log('Last update before license fee start date, skipping payout');
    return;
  }

  const date = dayjs.utc(lastUpdate).startOf('day').toDate();
  const dateStr = formatDate(date, 'YYYY-MM-DD', true);
  log(`Starting license fee payout for date: ${dateStr}`);

  const rows = await clickhouse.$query<LicenseFeeRow>`
    SELECT
      modelVersionId,
      accountType,
      SUM(FLOOR(amount))::int AS amount
    FROM orchestration.resourceCompensations
    WHERE date = ${date}
      AND source = 'license'
    GROUP BY modelVersionId, accountType
    HAVING amount > 0;
  `;

  log(`Found ${rows.length} license fee rows from ClickHouse`);

  if (!rows.length) {
    log('No license fees found, skipping payout');
    return;
  }

  const creatorsToPay: Record<number, LicenseFeeRow[]> = {};
  const batches = chunk(rows, BATCH_SIZE);

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
  log(`Mapped license fees to ${creatorCount} creators`);

  if (isEmpty(creatorsToPay)) {
    log('No creators to pay after mapping, skipping payout');
    return;
  }

  const transactions = Object.entries(creatorsToPay)
    .flatMap(([userId, fees]) => {
      const grouped = fees.reduce<Partial<Record<BuzzAccountType, number>>>((acc, f) => {
        acc[f.accountType] = (acc[f.accountType] || 0) + f.amount;
        return acc;
      }, {});

      return Object.entries(grouped).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: Number(userId),
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        amount,
        description: `License fee payout (${formatDate(date, 'MMM D, YYYY', true)})`,
        type: TransactionType.LicenseFee,
        externalTransactionId: `license-fee-${dateStr}-${userId}-${accountType}`,
      }));
    })
    .filter((tx) => tx.amount > 0);

  const totalAmount = transactions.reduce((sum, tx) => sum + tx.amount, 0);
  log(`Created ${transactions.length} license fee transactions totaling ${totalAmount}`);

  const txBatches = chunk(transactions, BATCH_SIZE);
  let processedBatches = 0;
  const tasks = txBatches.map((batch) => async () => {
    await withRetries(() => createBuzzTransactionMany(batch), 1);
    processedBatches++;
    log(`Processed batch ${processedBatches}/${txBatches.length} (${batch.length} transactions)`);

    const batchStats = batch.reduce((acc, tx) => {
      const accountType = tx.toAccountType;
      if (!acc[accountType]) acc[accountType] = { creators: new Set<number>(), amount: 0 };
      acc[accountType].creators.add(tx.toAccountId);
      acc[accountType].amount += tx.amount;
      return acc;
    }, {} as Record<BuzzAccountType, { creators: Set<number>; amount: number }>);

    Object.entries(batchStats).forEach(([accountType, stats]) => {
      licenseFeeCreatorsPaidCounter.inc({ account_type: accountType }, stats.creators.size);
      licenseFeeAmountPaidCounter.inc({ account_type: accountType }, stats.amount);
    });
  });

  await limitConcurrency(tasks, 2);

  log(`✅ License fee payout complete: ${creatorCount} creators paid ${totalAmount}`);
}
