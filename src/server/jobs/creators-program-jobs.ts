import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransactionMany, getAccountsBalances } from '~/server/services/buzz.service';
import {
  bustCompensationPoolCache,
  flushBankedCache,
  getCompensationPool,
  getPoolParticipantsV2,
  getUserCapCache,
  userCashCache,
} from '~/server/services/creator-program.service';
import { createTipaltiPayee } from '~/server/services/user-payment-configuration.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import {
  CAPPED_BUZZ_VALUE,
  FIRST_CREATOR_PROGRAM_MONTH,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';
import { createJob } from './job';
import {
  NotificationCategory,
  OnboardingSteps,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import type { CreatorProgramStageNotification } from '~/server/utils/creator-program.utils';
import {
  getCreatorProgramAvailability,
  isStageNotificationDay,
} from '~/server/utils/creator-program.utils';
import { createNotification } from '~/server/services/notification.service';
import { logToAxiom } from '~/server/logging/client';
import { Prisma } from '@prisma/client';

export const creatorsProgramDistribute = createJob(
  'creators-program-distribute',
  '2 23 L * *',
  async () => {
    if (!clickhouse) return;

    const availability = getCreatorProgramAvailability();
    if (!availability.isAvailable) return;

    // Determine `month` we're settling
    let month = await dbKV.get('compensation-pool-month', FIRST_CREATOR_PROGRAM_MONTH);
    month = dayjs(month).startOf('month').toDate();

    // Get unified pool data
    const pool = await getCompensationPool({ month });
    // Get all participants from unified bank
    const participants = await getPoolParticipantsV2(month, false);

    // Allocate pool value based on participant portion
    const allAllocations: [number, number][] = [];
    const allAffectedUsers = new Set<number>();
    let availablePoolValue = Math.floor(pool.value * 100);

    if (pool.size.current <= 0 || availablePoolValue <= 0) {
      // Nothing to distribute
      month = dayjs(month).add(1, 'month').toDate();
      await dbKV.set('compensation-pool-month', month);
      return;
    }

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
      allAllocations.push([participant.userId, participantShare]);
      allAffectedUsers.add(participant.userId);
      availablePoolValue -= participantShare;
    }

    // Send pending cash transactions from bank with retry
    const monthStr = dayjs(month).format('YYYY-MM');
    await withRetries(async () => {
      await createBuzzTransactionMany(
        allAllocations.map(([userId, amount]) => ({
          type: TransactionType.Compensation,
          toAccountType: 'cashPending',
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount,
          description: `Compensation Pool for ${monthStr}`,
          details: { month },
          externalTransactionId: `comp-pool-unified-${monthStr}-${userId}`,
        }))
      );
    });

    // Bust user caches
    const affectedUsers = Array.from(allAffectedUsers);
    userCashCache.bust(affectedUsers);

    signalClient.topicSend({
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
    if (!availability.isAvailable) return;
    const participants = await getPoolParticipantsV2(dayjs().subtract(1, 'months').toDate(), true);
    if (participants.length === 0) return;
    const balances = await getAccountsBalances({
      accountIds: participants.map((p) => p.userId),
      accountTypes: ['cashSettled'],
    });

    const userIdsOverThreshold = balances
      .filter((b) => b.balance > MIN_WITHDRAWAL_AMOUNT)
      .map((u) => u.accountId);

    const usersWithTipalti = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT
        "userId"
      FROM "UserPaymentConfiguration" uc
      WHERE "tipaltiAccountId" IS NOT NULL
      AND "userId" IN (${Prisma.join(userIdsOverThreshold)});
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

    signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });

    await logToAxiom({
      name: 'creator-program-invite-tipalti',
      type: 'creator-program-invite-tipalti',
      invited: usersWithoutTipalti,
      status: 'success',
      message: 'Tipalti users invited successfully',
    });
  }
);

export const creatorsProgramRollover = createJob(
  'creators-program-rollover',
  '0 0 1 * *',
  async () => {
    await getUserCapCache().flush();
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
    if (!availability.isAvailable) return;

    const month = dayjs().subtract(1, 'months').toDate();
    const participants = await getPoolParticipantsV2(month, true);
    const balances = await getAccountsBalances({
      accountIds: participants.map((p) => p.userId),
      accountTypes: ['cashPending'],
    });

    const positiveBalances = balances.filter((b) => b.balance > 0);
    if (positiveBalances.length === 0) return;

    // Settle pending cash transactions from bank with retry
    const monthStr = dayjs().format('YYYY-MM');
    await withRetries(async () => {
      try {
        await createBuzzTransactionMany(
          positiveBalances.flatMap(({ accountId: userId, balance: amount }) => [
            {
              type: TransactionType.Compensation,
              fromAccountType: 'cashPending',
              fromAccountId: userId,
              toAccountType: 'cashSettled',
              toAccountId: 0,
              amount,
              description: `Move from pending ${monthStr}`,
              externalTransactionId: `settlement-bank-v2-${monthStr}-${userId}`,
            },
            {
              type: TransactionType.Compensation,
              fromAccountType: 'cashSettled',
              fromAccountId: 0,
              toAccountType: 'cashSettled',
              toAccountId: userId,
              amount,
              description: `Cash settlement for ${monthStr}`,
              externalTransactionId: `settlement-v2-${monthStr}-${userId}`,
            },
          ])
        );

        await logToAxiom({
          name: 'creator-program-settle-cash',
          type: 'creator-program-settle-cash',
          positiveBalances,
          status: 'success',
          message: 'Settled cash transactions successfully',
        });
      } catch (e) {
        await logToAxiom({
          name: 'creator-program-settle-cash',
          type: 'creator-program-settle-cash',
          error: e,
          positiveBalances,
        });

        throw e;
      }
    });

    const affectedUsers = positiveBalances.map((p) => p.accountId);

    // Notify users of cash settlement
    await createNotification({
      type: 'creator-program-funds-settled',
      category: NotificationCategory.Creator,
      key: `creator-program-funds-settled:${monthStr}`,
      userIds: affectedUsers,
      details: {},
    });

    // Bust user caches
    await userCashCache.bust(affectedUsers);
    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });

    return positiveBalances;
  }
);

// activeMembershipOnly mirrors hasValidCreatorMembership set-wise (any buzzType,
// non-terminal status, not renewal-lapsed, tier above founder) so lapsed members
// — who keep the onboarding flag — can be excluded from nudges they can't act on.
const getCreatorProgramUsers = async ({
  activeMembershipOnly = false,
}: { activeMembershipOnly?: boolean } = {}) => {
  const users = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT "id" as "userId"
      FROM "User" u
      WHERE "onboarding" & ${OnboardingSteps.CreatorProgram} != 0
      ${
        activeMembershipOnly
          ? Prisma.sql`AND EXISTS (
              SELECT 1
              FROM "CustomerSubscription" cs
              JOIN "Product" p ON p.id = cs."productId"
              WHERE cs."userId" = u.id
                AND cs.status NOT IN ('canceled', 'incomplete_expired', 'past_due', 'unpaid')
                AND COALESCE(cs.metadata->>'renewalEmailSent', '') <> 'true'
                AND p.metadata->>${env.TIER_METADATA_KEY} NOT IN ('free', 'founder')
            )`
          : Prisma.empty
      }
    `;

  return users.map((u) => u.userId);
};

function createStageNotificationJob(
  stage: CreatorProgramStageNotification,
  getUserIds: () => Promise<number[]>
) {
  // Runs daily and gates on getPhases rather than encoding the day in an `L-n` cron: the
  // scheduler kept firing a stale `L-n` for these jobs after their crons changed. The names
  // differ from the old `creator-program-<stage>` jobs so the scheduler registers new triggers.
  return createJob(`creator-program-notify-${stage}`, '0 0 * * *', async () => {
    const now = new Date();
    if (!isStageNotificationDay(stage, now)) return;

    const month = dayjs.utc(now).format('YYYY-MM');
    const userIds = await getUserIds();

    await createNotification({
      type: `creator-program-${stage}`,
      category: NotificationCategory.Creator,
      key: `creator-program-${stage}:${month}`,
      userIds,
      details: {},
    });
  });
}

// Banking nudge: only people who can actually still bank.
export const bankingPhaseEndingNotification = createStageNotificationJob(
  'banking-phase-ending',
  () => getCreatorProgramUsers({ activeMembershipOnly: true })
);

export const extractionPhaseStartedNotification = createStageNotificationJob(
  'extraction-phase-started',
  () => getCreatorProgramUsers()
);

export const extractionPhaseEndingNotification = createStageNotificationJob(
  'extraction-phase-ending',
  () => getCreatorProgramUsers()
);

export const creatorProgramJobs = [
  creatorsProgramDistribute,
  creatorsProgramInviteTipalti,
  creatorsProgramRollover,
  creatorsProgramSettleCash,
  bankingPhaseEndingNotification,
  extractionPhaseStartedNotification,
  extractionPhaseEndingNotification,
];
