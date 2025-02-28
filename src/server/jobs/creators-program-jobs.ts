import dayjs from 'dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import {
  bustCompensationPoolCache,
  flushBankedCache,
  getCompensationPool,
  getPoolParticipants,
  userCapCache,
  userCashCache,
} from '~/server/services/creator-program.service';
import { createTipaltiPayee } from '~/server/services/user-payment-configuration.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import {
  CAPPED_BUZZ_VALUE,
  EXTRACTION_PHASE_DURATION,
  FIRST_CREATOR_PROGRAM_MONTH,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';
import { createJob } from './job';
import { OnboardingSteps, SignalMessages, SignalTopic } from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import { getCreatorProgramAvailability } from '~/server/utils/creator-program.utils';

export const creatorsProgramDistribute = createJob(
  'creators-program-distribute',
  '2 23 L * *',
  async () => {
    if (!clickhouse) return;

    const availability = getCreatorProgramAvailability();
    if (!availability) return;

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
          description: `Compensation Pool for ${monthStr}`,
          details: { month },
          externalTransactionId: `comp-pool-${monthStr}-${userId}`,
        }))
      );
    });

    // Bust user caches
    const affectedUsers = participants.map((p) => p.userId);
    userCashCache.bust(affectedUsers);

    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });

    // Update month
    month = dayjs(month).add(1, 'month').toDate();
    await dbKV.set('compensation-pool-month', month);
  }
);

export const creatorsProgramInviteTipalti = createJob(
  'creators-program-invite-tipalti',
  '50 23 L * *',
  async () => {
    const availability = getCreatorProgramAvailability();
    if (!availability) return;
    // Send tipalti invite to users with $50+ in cash without a tipalti account
    const usersOverThreshold = await clickhouse!.$query<{ userId: number; balance: number }>`
      WITH affected AS (
        SELECT DISTINCT toAccountId as id
        FROM buzzTransactions
        WHERE toAccountType = 'cash-pending'
        AND date > subtractDays(now(), 1)
      )
      SELECT
        toAccountId as userId,
        SUM(if(toAccountType = 'cash-pending' OR (toAccountType = 'cash-settled' AND fromAccountType != 'cash-pending'), amount, 0)) as balance
      FROM buzzTransactions
      WHERE toAccountType IN ('cash-pending', 'cash-settled')
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
    userCashCache.bust(usersWithoutTipalti);

    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });
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

    const availability = getCreatorProgramAvailability();
    if (!availability) return;

    const pendingCash = await clickhouse.$query<{ userId: number; amount: number }>`
      SELECT
        toAccountId as userId,
        SUM(if(toAccountType = 'cash-settled', amount, -amount)) as amount
      FROM buzzTransactions
      WHERE (
        -- Settlements
        fromAccountType = 'cash-settled'
        AND toAccountType = 'cash-settled'
      ) OR (
        -- Deposits
        fromAccountId = 0
        AND toAccountType = 'cash-settled'
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
    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });
  }
);

export const bakingPhaseNotification = createJob(
  'creators-program-rollover',
  `0 0 L-${EXTRACTION_PHASE_DURATION - 1} * *`,
  async () => {
    const users = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT "id" as "userId"
      FROM "User"
      WHERE "onboarding" & ${OnboardingSteps.CreatorProgram} != 0
    `;
  }
);

export const creatorProgramJobs = [
  creatorsProgramDistribute,
  creatorsProgramInviteTipalti,
  creatorsProgramRollover,
  creatorsProgramSettleCash,
];
