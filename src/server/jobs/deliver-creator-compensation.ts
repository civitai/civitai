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
import {
  CASH_SETTLED_ALIASES,
  GENERATION_TIP_TRANSACTION_PREFIX,
  TransactionType,
} from '~/shared/constants/buzz.constants';
import {
  creatorCompAmountPaidCounter,
  creatorCompCreatorsPaidCounter,
  generationTipAmountPaidCounter,
  generationTipCreatorsPaidCounter,
  licenseFeeAmountPaidCounter,
  licenseFeeCreatorsPaidCounter,
} from '~/server/prom/client';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('creator-compensation', 'green');

export const updateCreatorResourceCompensation = createJob(
  'deliver-creator-compensation',
  '0 2 * * *', // Run 2:00 AM UTC daily
  async () => {
    await payDueCompensation(new Date());
  }
);

/** Dates one run pays at most. A stale or corrupted last-payout value must never make one run pay months. */
export const MAX_PAYOUT_DATES_PER_RUN = 7;

/**
 * The UTC payout dates still owed, oldest first: from the day `lastPayout` falls on through yesterday.
 * `lastPayout` names the next date to pay; today is never due because its compensation is still accruing.
 */
export function payoutDatesDue(lastPayout: Date, now: Date): Date[] {
  const today = dayjs.utc(now).startOf('day');
  const dates: Date[] = [];
  for (let day = dayjs.utc(lastPayout).startOf('day'); day.isBefore(today); day = day.add(1, 'day'))
    dates.push(day.toDate());
  return dates;
}

export async function payDueCompensation(now: Date) {
  if (!clickhouse) {
    log('ClickHouse not available, skipping job');
    return;
  }

  const [lastPayout, setLastPayout] = await getJobDate('run-daily-compensation-payout', now);
  const due = payoutDatesDue(lastPayout, now);
  if (!due.length) {
    log('Payout already ran today, skipping');
    return;
  }

  if (due.length > MAX_PAYOUT_DATES_PER_RUN) {
    const message = `Creator compensation is ${due.length} payout dates behind; paying the oldest ${MAX_PAYOUT_DATES_PER_RUN} this run`;
    log(`⚠️ ${message}`);
    logToAxiom({
      type: 'error',
      name: 'creator-compensation-backlog',
      message,
      details: {
        lastPayout: lastPayout.toISOString(),
        oldestDue: formatDate(due[0], 'YYYY-MM-DD', true),
        datesDue: due.length,
      },
    }).catch(() => undefined);
  }

  for (const date of due.slice(0, MAX_PAYOUT_DATES_PER_RUN)) {
    const dateStr = formatDate(date, 'YYYY-MM-DD', true);
    try {
      await runPayout(date);
    } catch (error) {
      log(`❌ Payout failed for ${dateStr}:`, error);
      throw error;
    }
    // The next date to pay, not now(): a run that fails on a later date, or a retry on another day,
    // resumes at the first unpaid date instead of skipping it.
    await setLastPayout(dayjs.utc(date).add(1, 'day').toDate());
    log(`Paid ${dateStr}, updated last payout date`);

    try {
      await clickhouse.$query`
        INSERT INTO kafka.manual_events VALUES
          (now(), 'update-compensation', '{"date":"${dateStr}"}');
      `;
      log('Queued compensation update event to Kafka');
    } catch (error) {
      log('Error queueing compensation update event to Kafka:', error);
    }
  }
}

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

type PayoutSource = 'compensation' | 'tip' | 'licenseFee';
export type PayoutTransaction = {
  fromAccountId: number;
  toAccountId: number;
  fromAccountType: BuzzAccountType;
  toAccountType: BuzzAccountType;
  amount: number;
  description: string;
  type: TransactionType;
  externalTransactionId: string;
  source: PayoutSource;
};

/**
 * Payout dates from this day on pay generation tips in their own transaction. Earlier dates keep the
 * combined transaction exactly: a retried run of a day already paid that way must only resend keys
 * that already exist, because a new tip key would pay those tips a second time.
 */
export const GENERATION_TIP_TRANSACTION_START = new Date('2026-10-13T00:00:00Z');

export function buildPayoutTransactions(
  date: Date,
  creatorsToPay: Record<number, ResourceRow[]>
): PayoutTransaction[] {
  const dateStr = formatDate(date, 'YYYY-MM-DD', true);
  const dateLabel = formatDate(date, 'MMM D, YYYY', true);
  const splitTips = date >= GENERATION_TIP_TRANSACTION_START;

  // cashSettled rows arrive in tenths-of-a-penny; the cashSettled account
  // ledger uses pennies, so we divide by 10 before minting.
  return Object.entries(creatorsToPay)
    .flatMap(([userIdStr, userRows]) => {
      const userId = Number(userIdStr);
      // Compensation plus tips, as one total: the comp transaction is what is left of its floor once
      // the tips are paid, so splitting never changes what a creator receives.
      const compTotals: Partial<Record<BuzzAccountType, number>> = {};
      const tipTotals: Partial<Record<BuzzAccountType, number>> = {};
      const licenseTotals: Partial<Record<BuzzAccountType, number>> = {};

      for (const row of userRows) {
        const isCash = CASH_SETTLED_ALIASES.has(row.accountType);
        const amount =
          row.source === 'licenseFee' && isCash ? Math.floor(row.amount / 10) : row.amount;
        if (row.source === 'licenseFee') {
          licenseTotals[row.accountType] = (licenseTotals[row.accountType] || 0) + amount;
          continue;
        }
        compTotals[row.accountType] = (compTotals[row.accountType] || 0) + amount;
        if (splitTips && row.source === 'tip')
          tipTotals[row.accountType] = (tipTotals[row.accountType] || 0) + amount;
      }

      const compTx = Object.entries(compTotals).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: userId,
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        // Sum-then-floor once at the daily boundary (amounts arrive fractional from the query now that we no
        // longer floor per row — required so sub-buzz license fees accumulate instead of flooring to 0).
        amount: Math.floor(amount) - Math.floor(tipTotals[accountType as BuzzAccountType] ?? 0),
        // Matches the "Generation compensation" channel label in Creator Studio. The externalTransactionId
        // keeps its prefix — it's a dedup key.
        description: `Generation compensation (${dateLabel})`,
        type: TransactionType.Compensation,
        externalTransactionId: `creator-tip-comp-${dateStr}-${userId}-${accountType}`,
        source: 'compensation' as const,
      }));

      // Still `Compensation`, so peak and pool queries treat tips as before; the bankable predicate
      // and other ledger readers tell them apart by this externalTransactionId prefix.
      const tipTx = Object.entries(tipTotals).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: userId,
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        amount: Math.floor(amount),
        description: `Generation tips (${dateLabel})`,
        type: TransactionType.Compensation,
        externalTransactionId: `${GENERATION_TIP_TRANSACTION_PREFIX}${dateStr}-${userId}-${accountType}`,
        source: 'tip' as const,
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
        description: `License fee payout (${dateLabel})`,
        type: TransactionType.LicenseFee,
        externalTransactionId: `license-fee-${dateStr}-${userId}-${accountType}`,
        source: 'licenseFee' as const,
      }));

      return [...compTx, ...tipTx, ...licenseTx];
    })
    .filter((tx) => tx.amount > 0);
}

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

  const transactions = buildPayoutTransactions(date, creatorsToPay);

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

      // Track metrics per (source, accountType) so license payouts and tips surface
      // in their own counters without having to demux later.
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
            source: PayoutSource;
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
        } else if (source === 'tip') {
          generationTipCreatorsPaidCounter.inc({ account_type: accountType }, creators.size);
          generationTipAmountPaidCounter.inc({ account_type: accountType }, amount);
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
