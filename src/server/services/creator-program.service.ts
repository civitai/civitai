import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import {
  NotificationCategory,
  OnboardingSteps,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import type {
  CashWithdrawalMetadataSchema,
  CompensationPoolInput,
  UpdateCashWithdrawalSchema,
} from '~/server/schema/creator-program.schema';
import type { UserTier } from '~/server/schema/user.schema';
import {
  createBuzzTransaction,
  getCounterPartyBuzzTransactions,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { payToTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import {
  bustFetchThroughCache,
  clearCacheByPattern,
  createCachedObject,
  fetchThroughCache,
} from '~/server/utils/cache-helpers';
import {
  getCurrentValue,
  getExtractionFee,
  getPhases,
  getWithdrawalFee,
  getWithdrawalRefCode,
} from '~/server/utils/creator-program.utils';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { invalidateSession } from '~/server/utils/session-helpers';
import type { CapDefinition } from '~/shared/constants/creator-program.constants';
import {
  CAP_DEFINITIONS,
  MIN_CAP,
  MIN_CREATOR_SCORE,
  MIN_WITHDRAWAL_AMOUNT,
  PEAK_EARNING_WINDOW,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { Flags } from '~/shared/utils/flags';
import { CashWithdrawalMethod, CashWithdrawalStatus } from '~/shared/utils/prisma/enums';
import { withRetries } from '~/utils/errorHandling';
import { signalClient } from '~/utils/signal-client';
import { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import { formatToLeastDecimals } from '~/utils/number-helpers';

type UserCapCacheItem = {
  id: number;
  definition: CapDefinition;
  peakEarning: { month: Date; earned: number };
  cap: number;
};

export const userCapCache = createCachedObject<UserCapCacheItem>({
  key: REDIS_KEYS.CREATOR_PROGRAM.CAPS,
  idKey: 'id',
  dontCacheFn: (data) => !data.cap,
  cacheNotFound: false,
  staleWhileRevalidate: false,
  debounceTime: 1, // 10s debounce is too long for this cache.
  lookupFn: async (ids) => {
    if (ids.length === 0 || !clickhouse) return {};

    // Get tiers
    const subscriptions = await dbWrite.$queryRawUnsafe<{ userId: number; tier: UserTier }[]>(`
      SELECT
        cs."userId",
        (p.metadata->>'tier') as tier
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      WHERE cs."userId" IN (${ids.join(',')});
    `);

    const peakEarnings = await clickhouse.$query<{ id: number; month: Date; earned: number }>`
      SELECT
        toAccountId as id,
        toStartOfMonth(date) as month,
        SUM(amount) as earned
      FROM buzzTransactions
      WHERE (
        (type IN ('compensation')) -- Generation Comp
        OR (type = 'tip' AND fromAccountId = 0) -- Generation Tip
        OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
      )
      AND toAccountType = 'user'
      AND toAccountId IN (${ids})
      AND toStartOfMonth(date) >= toStartOfMonth(subtractMonths(now(), ${PEAK_EARNING_WINDOW}))
      AND toStartOfMonth(date) < toStartOfMonth(now())
      GROUP BY month, toAccountId
      ORDER BY earned DESC
      LIMIT 1;
    `;

    return Object.fromEntries(
      subscriptions.map((s) => {
        const definition = CAP_DEFINITIONS.find((cap) => cap.tier === s.tier);
        if (!definition) throw new Error('Invalid user tier');

        const peakEarning = peakEarnings.find((p) => p.id === s.userId) ?? {
          id: s.userId,
          month: new Date(),
          earned: 0,
        };

        let cap = definition.limit ?? MIN_CAP;
        if (definition.percentOfPeakEarning && peakEarning?.earned) {
          const peakEarnedCap = peakEarning.earned * definition.percentOfPeakEarning;
          if (peakEarnedCap < MIN_CAP) cap = MIN_CAP;
          else cap = Math.min(peakEarnedCap, definition.limit ?? Infinity);
        }

        return [s.userId, { id: s.userId, definition, peakEarning, cap }];
      })
    );
  },
  ttl: CacheTTL.day,
});

export async function getBankCap(userId: number) {
  return userCapCache.fetch(userId);
}

export function getMonthAccount(month?: Date) {
  month ??= new Date();
  return Number(dayjs(month).format('YYYYMM'));
}

export async function getBanked(userId: number) {
  const monthAccount = getMonthAccount();
  const total = await fetchThroughCache(
    `${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`,
    async () => {
      const data = await getCounterPartyBuzzTransactions({
        accountId: monthAccount,
        accountType: 'creatorprogrambank',
        counterPartyAccountId: userId,
        counterPartyAccountType: 'user',
      });

      return data.totalBalance;
    },
    { ttl: CacheTTL.day }
  );

  return {
    total,
    cap: (await getBankCap(userId))[userId],
  };
}
export async function flushBankedCache() {
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:*`);
}

export async function getCreatorRequirements(userId: number) {
  const [status] = await dbWrite.$queryRaw<{ score: number; membership: UserTier }[]>`
    SELECT
    -- We are doing greatest in case the meta->'scores'->'total' is not properly computated.
    -- Noticed a few cases where it was different than the total sum (lower). Safeguard here.
    GREATEST(
      COALESCE((u.meta->'scores'->>'models')::numeric, 0)
      + COALESCE((u.meta->'scores'->>'articles')::numeric, 0)
      + COALESCE((u.meta->'scores'->>'images')::numeric, 0)
      + COALESCE((u.meta->'scores'->>'users')::numeric, 0)
      + COALESCE((u.meta->'scores'->>'reportsActioned')::numeric, 0)
      + COALESCE((u.meta->'scores'->>'reportsAgainst')::numeric, 0),
      COALESCE((meta->'scores'->'total')::numeric, 0)
    ) as score,
    (
      SELECT p.metadata->>'tier'
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      WHERE status IN ('incomplete', 'active') AND cs."userId" = u.id
    ) as membership
    FROM "User" u
    WHERE id = ${userId};
  `;

  return {
    score: {
      min: MIN_CREATOR_SCORE,
      current: status.score,
    },
    membership: status.membership !== 'free' ? status.membership : undefined,
    validMembership:
      // We will not support founder tier.
      status.membership !== 'free' && status.membership !== 'founder' ? status.membership : false,
  };
}

export async function joinCreatorsProgram(userId: number) {
  const requirements = await getCreatorRequirements(userId);

  if (requirements.validMembership === false) {
    if (requirements.membership) {
      throw throwBadRequestError('Your current membership does not apply for the Creator Program');
    }
    throw throwBadRequestError('User is not a civitai member');
  }

  if (requirements.score.current < requirements.score.min) {
    throw throwBadRequestError('User does not meet the minimum creator score');
  }

  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }

  await dbWrite.$executeRaw`
    UPDATE "User" SET onboarding = onboarding | ${OnboardingSteps.CreatorProgram}
    WHERE id = ${userId};
  `;
  await invalidateSession(userId);
}

async function getPoolValue(month?: Date) {
  month ??= new Date();
  const results = await clickhouse!.$query<{ balance: number }>`
    SELECT
        SUM(amount) / 1000 AS balance
    FROM buzzTransactions
    WHERE toAccountType = 'user'
    AND (
      type = 'purchase'
      OR (type = 'redeemable' AND description LIKE 'Redeemed code SH-%')
    )
    AND fromAccountId = 0
    AND externalTransactionId NOT LIKE 'renewalBonus:%'
    AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(${month}, 1));
  `;

  if (!results.length || !env.CREATOR_POOL_TAXES || !env.CREATOR_POOL_PORTION) return 35000;
  const gross = results[0].balance;
  const taxesAndFees = gross * (env.CREATOR_POOL_TAXES / 100);
  const poolValue = (gross - taxesAndFees) * (env.CREATOR_POOL_PORTION / 100);
  return poolValue;
}

async function getPoolSize(month?: Date) {
  month ??= new Date();
  const monthAccount = getMonthAccount(month);
  const account = await getUserBuzzAccount({
    accountId: monthAccount,
    accountType: 'creatorprogrambank',
  });

  return account.balance ?? 0;
}

async function getPoolForecast(month?: Date) {
  month ??= new Date();
  const [result] = await clickhouse!.$query<{ balance: number }>`
    SELECT
      SUM(amount) AS balance
    FROM buzzTransactions
    WHERE toAccountType = 'user'
    AND (
      (type IN ('compensation','tip')) -- Generation
      OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
    )
    AND toAccountId != 0
    AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(${month}, 1));
  `;
  return result.balance * (env.CREATOR_POOL_FORECAST_PORTION / 100);
}

export async function getCompensationPool({ month }: CompensationPoolInput) {
  if (month) {
    // Skip catching if fetching specific month
    return {
      value: await getPoolValue(month),
      size: {
        current: await getPoolSize(month),
        forecasted: await getPoolForecast(month),
      },

      phases: getPhases({ month, flip: (await getFlippedPhaseStatus()) === 'true' }),
    };
  }

  const value = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.POOL_VALUE,
    async () => await getPoolValue(),
    { ttl: CacheTTL.day }
  );

  // Since it hits the buzz service, no need to cache this.
  const current = await getPoolSize();

  const forecasted = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.POOL_FORECAST,
    async () => await getPoolForecast(),
    { ttl: CacheTTL.day }
  );

  return {
    value,
    size: {
      current,
      forecasted,
    },
    // TODO: Remove flip when we're ready to go live
    phases: getPhases({ flip: (await getFlippedPhaseStatus()) === 'true' }),
  };
}

export async function bustCompensationPoolCache() {
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_VALUE);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_FORECAST);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.PREV_MONTH_STATS);
}

async function getFlippedPhaseStatus() {
  return await sysRedis.get(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES);
}

export async function bankBuzz(userId: number, amount: number) {
  // Check that we're in the banking phase
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }
  // TODO: Remove flip when we're ready to go live
  const phases = getPhases({ flip: (await getFlippedPhaseStatus()) === 'true' });
  if (new Date() > phases.bank[1]) throw new Error('Banking phase is closed');

  // Adjust to not exceed cap
  const banked = await getBanked(userId);
  if (banked.cap.cap < banked.total + amount) amount = banked.cap.cap - banked.total;
  if (amount <= 0) throw new Error('Amount exceeds cap');

  // Create buzz transaction to bank
  const monthAccount = getMonthAccount();
  await createBuzzTransaction({
    amount,
    fromAccountId: userId,
    fromAccountType: 'user',
    toAccountId: monthAccount,
    toAccountType: 'creatorprogrambank',
    type: TransactionType.Bank,
    description: 'Banked for Creator Program',
  });

  // Bust affected caches

  await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);

  const compensationPool = await getCompensationPool({});
  signalClient.topicSend({
    topic: SignalTopic.CreatorProgram,
    target: SignalMessages.CompensationPoolUpdate,
    data: compensationPool,
  });
}

export async function extractBuzz(userId: number) {
  // Check that we're in the extraction phase
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }

  // TODO: Remove flip when we're ready to go live
  const phases = getPhases({ flip: (await getFlippedPhaseStatus()) === 'true' });
  if (new Date() < phases.extraction[0]) throw new Error('Extraction phase has not started');
  else if (new Date() > phases.extraction[1]) throw new Error('Extraction phase is closed');

  // Get banked amount
  const banked = await getBanked(userId);
  if (banked.total <= 0) return;

  // Calculate extraction fee
  const fee = getExtractionFee(banked.total);

  // Charge fee and extract banked amount
  // Give full amount back to user, to then take fee...
  const monthAccount = getMonthAccount();
  await createBuzzTransaction({
    amount: banked.total,
    fromAccountId: monthAccount,
    fromAccountType: 'creatorprogrambank',
    toAccountId: userId,
    toAccountType: 'user',
    type: TransactionType.Extract,
    externalTransactionId: `extraction-${monthAccount}-${userId}`,
    description: `Extracted from Bank`,
  });

  if (fee > 0) {
    // Burn fee
    await createBuzzTransaction({
      amount: fee,
      fromAccountId: userId,
      fromAccountType: 'user',
      toAccountId: 0,
      toAccountType: 'user',
      type: TransactionType.Fee,
      externalTransactionId: `extraction-fee-${monthAccount}-${userId}`,
      description: 'Extraction fee',
    });
  }

  // Bust affected caches
  await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);

  const compensationPool = await getCompensationPool({});
  signalClient.topicSend({
    topic: SignalTopic.CreatorProgram,
    target: SignalMessages.CompensationPoolUpdate,
    data: compensationPool,
  });
}

type UserCashCacheItem = {
  id: number;
  status: 'pending' | 'ready';
  pending: number;
  ready: number;
  withdrawn: number;
  paymentMethod: CashWithdrawalMethod;
  withdrawalFee?: {
    type: 'fixed' | 'percent';
    amount: number; // Fixed amount or percent
  };
};

export const userCashCache = createCachedObject<UserCashCacheItem>({
  key: REDIS_KEYS.CREATOR_PROGRAM.CASH,
  idKey: 'id',
  staleWhileRevalidate: false,
  debounceTime: 1, // 10s debounce is too long for this cache.
  lookupFn: async (ids) => {
    if (ids.length === 0 || !clickhouse) return {};

    if (ids.length > 10) {
      // Safeguard due to the buzz account fetch. So far this is not a concern as this cache is only called
      // with 1 single user, however, worth keeping in mind.
      throw new Error('Too many users to fetch');
    }

    const statuses = await dbWrite.$queryRawUnsafe<
      { userId: number; status: 'pending' | 'ready'; withdrawalMethod?: CashWithdrawalMethod }[]
    >(`
      SELECT
        "userId",
        IIF("tipaltiAccountStatus" = 'Active', 'ready'::text, 'pending'::text) as status,
        COALESCE("tipaltiWithdrawalMethod", 'NoPM') as "withdrawalMethod"
      FROM "UserPaymentConfiguration" uc
      WHERE "userId" IN (${ids.join(',')});
    `);

    const buzzAccountBalances = await Promise.all(
      ids.map(async (id) => {
        const pending = await getUserBuzzAccount({
          accountId: id,
          accountType: 'cashpending',
        });
        const settled = await getUserBuzzAccount({
          accountId: id,
          accountType: 'cashsettled',
        });
        return {
          id,
          pending: pending.balance ?? 0,
          ready: settled.balance ?? 0,
        };
      })
    );

    const withdrawals = await dbWrite.$queryRawUnsafe<{ userId: number; amount: number }[]>(`
      SELECT
        "userId",
        SUM(amount)::INT as amount
      FROM "CashWithdrawal" cw
      WHERE "userId" IN (${ids.join(',')})
        AND status NOT IN ('Rejected', 'Canceled', 'FailedFee')
      GROUP BY "userId";
    `);

    const paymentMethods = ids.map((id) => ({
      userId: id,
      method: statuses.find((s) => s.userId === id)?.withdrawalMethod,
    }));

    return Object.fromEntries(
      ids.map((id) => {
        const status = statuses.find((s) => s.userId === id)?.status ?? 'pending';
        const withdrawn = withdrawals.find((w) => w.userId === id)?.amount ?? 0;
        const paymentMethod = (paymentMethods.find((m) => m.userId === id)?.method ??
          CashWithdrawalMethod.NoPM) as CashWithdrawalMethod;
        const { ready, pending } = buzzAccountBalances.find((b) => b.id === id) ?? {
          ready: 0,
          pending: 0,
        };
        return [id, { id, status, withdrawn, paymentMethod, ready, pending }];
      })
    );
  },
  appendFn: async (items) => {
    // Append withdrawal fees
    for (const item of items) {
      item.withdrawalFee = WITHDRAWAL_FEES[item.paymentMethod];
    }
  },
  // Users may be extracting / managing their cash often, so we'll keep this cache short,
  // Specially now that clickhouse is not involved.
  ttl: CacheTTL.day,
});
export async function getCash(userId: number) {
  return (await userCashCache.fetch(userId))[userId];
}

export async function getWithdrawalHistory(userId: number) {
  const transactions = await dbWrite.cashWithdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      method: true,
      amount: true,
      status: true,
      note: true,
      fee: true,
    },
  });

  return transactions;
}

export async function withdrawCash(userId: number, amount: number) {
  // Check setup for withdrawal
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }

  const cash = await getCash(userId);
  if (cash.status === 'pending') throw new Error('Payment setup is pending');

  // Check that amount is valid
  if (amount < MIN_WITHDRAWAL_AMOUNT) throw new Error('Amount is below minimum');

  // Ensure they're payable:
  const userPaymentConfiguration = await dbWrite.userPaymentConfiguration.findUnique({
    where: { userId },
  });

  if (!userPaymentConfiguration?.tipaltiPaymentsEnabled) {
    throw new Error('User is not payable');
  }

  if (
    !userPaymentConfiguration.tipaltiWithdrawalMethod ||
    userPaymentConfiguration.tipaltiWithdrawalMethod === CashWithdrawalMethod.NoPM
  ) {
    throw new Error(
      'We could not determine your Tipalti payment method. Please update it and check back.'
    );
  }

  if (!WITHDRAWAL_FEES[userPaymentConfiguration.tipaltiWithdrawalMethod]) {
    throw new Error('Selected withdrawal method is not supported');
  }

  // Determine withdrawal amount
  const fee = getWithdrawalFee(amount, cash.paymentMethod);
  const toWithdraw = amount - fee;

  // We will use this to keep track of our progress in the code below:
  const data = {
    withdrawalId: '',
    transactionId: '',
    paymentBatchId: '',
    paymentRefCode: '',
    updated: false,
  };

  try {
    // Create withdrawal record
    const { id } = await dbWrite.cashWithdrawal.create({
      data: {
        userId,
        amount: toWithdraw,
        fee,
        status: CashWithdrawalStatus.InternalValue,
        method: userPaymentConfiguration.tipaltiWithdrawalMethod,
      },
      select: {
        id: true,
      },
    });

    data.withdrawalId = id;

    // Burn full amount
    const { transactionId } = await createBuzzTransaction({
      amount,
      fromAccountId: userId,
      fromAccountType: 'cashsettled',
      toAccountId: 0,
      toAccountType: 'user',
      type: TransactionType.Withdrawal,
      description: 'Withdrawal request',
    });

    if (!transactionId) {
      throw new Error('Failed to create transaction');
    }

    data.transactionId = transactionId as string;

    // Update withdrawal record
    await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET "transactionId" = ${transactionId}, status = 'InternalValue'
      WHERE id = ${id};
    `;

    // Create tipalti payment
    const refCode = getWithdrawalRefCode(id, userId);

    const { paymentBatchId, paymentRefCode } = await payToTipaltiAccount({
      requestId: refCode,
      toUserId: userId as number, // Ofcs, user should exist for one.
      amount: toWithdraw / 100, // Tipalti doesn't use cents like 99% of other payment processors :shrug:
      description: `Payment for withdrawal request ${refCode}`,
      byUserId: -1, // The bank
    });

    data.paymentBatchId = paymentBatchId;
    data.paymentRefCode = paymentRefCode;
    // Update withdrawal record
    await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET status = 'InternalValue',
        metadata = jsonb_build_object(
          'paymentBatchId', ${paymentBatchId},
          'paymentRefCode', ${paymentRefCode},
          'paidAmount', ${toWithdraw}
        ),
        "note" = 'Payment waiting for Moderator approval'
      WHERE id = ${id};
    `;

    data.updated = true;

    // Bust affected caches
    await userCashCache.bust(userId);

    signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });
  } catch (e) {
    await logToAxiom({ name: 'withdraw-cash', type: 'error', error: e, ...data, userId });

    // In case of error, we need to revert the transaction
    if (data.updated) {
      // We cache bust or something of the sort. We should be OK to move forward.
      return;
    }

    if (data.paymentBatchId) {
      // We failed at updating. We should retry that:
      await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET status = 'InternalValue',
        metadata = jsonb_build_object(
          'paymentBatchId', ${data.paymentBatchId},
          'paymentRefCode', ${data.paymentRefCode},
          'paidAmount', ${toWithdraw}
        ),
        "note" = 'Payment waiting for Moderator approval'
      WHERE id = ${data.withdrawalId};
    `;

      return;
    }

    if (data.transactionId) {
      // We failed at creating the Tipalti payment. We should refund the user their buzz:
      await withRetries(async () => {
        await refundTransaction(
          data.transactionId,
          'Failed to create Tipalti payment. Please contact support.'
        );
      });
    }

    await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET status = 'Canceled',
        note = ${(e as Error).message}
      WHERE id = ${data.withdrawalId};
    `;

    // Bust affected caches
    await userCashCache.bust(userId);

    signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });

    throw e;
  }
}

export async function getPoolParticipants(month?: Date, includeNegativeAmounts = false) {
  month ??= new Date();
  const monthAccount = getMonthAccount(month);
  const participants = await clickhouse!.$query<{
    userId: number;
    amount: number;
    extracted: number;
  }>`
    SELECT
      if(toAccountType = 'creator-program-bank', fromAccountId, toAccountId) as userId,
      SUM(if(toAccountType = 'creator-program-bank', amount, -amount)) as amount,
      SUM(if(toAccountType = 'creator-program-bank', 0, bt.amount)) as extracted
    FROM buzzTransactions bt
    WHERE (
      -- Banks
      toAccountType = 'creator-program-bank'
      AND toAccountId = ${monthAccount}
      AND fromAccountType = 'user'
    ) OR (
      -- Extracts
      fromAccountType = 'creator-program-bank'
      AND fromAccountId = ${monthAccount}
      AND toAccountType = 'user'
    )
    GROUP BY userId
    ${includeNegativeAmounts ? '' : 'HAVING amount > 0'};
  `;

  let bannedParticipants: { userId: number }[] = [];

  if (participants.length > 0) {
    bannedParticipants = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT "id" as "userId"
      FROM "User"
      WHERE id IN (${Prisma.join(participants.map((p) => p.userId))})
        AND ("bannedAt" IS NOT NULL OR onboarding & ${OnboardingSteps.BannedCreatorProgram} != 0);
    `;
  }

  return participants.filter((p) => !bannedParticipants.some((b) => b.userId === p.userId));
}

export const updateCashWithdrawal = async ({
  withdrawalId,
  status,
  note,
  metadata: updatedMetadata,
  fees,
}: UpdateCashWithdrawalSchema) => {
  // Check if the user has  a pending withdrawal request:
  const withdrawal = await dbWrite.cashWithdrawal.findUniqueOrThrow({
    where: { id: withdrawalId },
  });

  const userId = withdrawal.userId;

  // We'll be deducting funds before the transaction mainly to avoid the tx taking too long. In the case of a tx failure, we'll  refund the user.
  let metadata: CashWithdrawalMetadataSchema = (withdrawal.metadata ??
    {}) as CashWithdrawalMetadataSchema;

  metadata = {
    ...metadata,
    ...(updatedMetadata ?? {}),
  };

  if (status === CashWithdrawalStatus.Rejected || status === CashWithdrawalStatus.Canceled) {
    if (withdrawal.transactionId) {
      await withRetries(async () => {
        const transaction = await createBuzzTransaction({
          type: TransactionType.Refund,
          toAccountType: 'cashsettled',
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount: withdrawal.amount - (fees ?? 0),
          description: `Refund for failed withdrawal. Fees: ${fees ?? 0}`,
          externalTransactionId: withdrawal.transactionId as string,
        });

        metadata.refundTransactionId = transaction.transactionId;

        if (fees) {
          await dbWrite.cashWithdrawal.create({
            data: {
              userId,
              transactionId: transaction.transactionId,
              amount: fees,
              status: CashWithdrawalStatus.FailedFee,
              metadata: metadata as any,
              fee: 0,
              method: CashWithdrawalMethod.Custom,
            },
          });
        }
      });
    }
  }

  try {
    // Ensure we update the main request details:
    await dbWrite.cashWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        status,
        note,
        metadata: metadata as any,
      },
    });

    switch (status) {
      case CashWithdrawalStatus.Scheduled:
      case CashWithdrawalStatus.Submitted:
        await createNotification({
          userId: userId as number,
          type: 'creators-program-withdrawal-approved',
          category: NotificationCategory.System,
          key: `creators-program-withdrawal-approved:${withdrawalId}`,
          details: {},
        }).catch();
        break;
      case CashWithdrawalStatus.Rejected:
        await createNotification({
          userId: userId as number,
          type: 'creators-program-withdrawal-rejected',
          category: NotificationCategory.System,
          key: `creators-program-withdrawal-rejected:${withdrawalId}`,
          details: {},
        }).catch();
        break;
      case CashWithdrawalStatus.Paid:
        await createNotification({
          userId: userId as number,
          type: 'creators-program-withdrawal-transferred',
          category: NotificationCategory.System,
          key: `creators-program-withdrawal-transferred:${withdrawalId}`,
          details: {},
        }).catch();
        break;
    }

    const updated = await dbWrite.cashWithdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
    });

    await userCashCache.bust(userId);

    signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });

    return updated;
  } catch (e) {
    throw e;
  }
};

export const getPrevMonthStats = async () => {
  const data = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.PREV_MONTH_STATS,
    async () => {
      const month = dayjs().subtract(1, 'month').toDate();
      const compensationPool = await getCompensationPool({ month });
      const participants = (await getPoolParticipants(month, true)).sort(
        (a, b) => b.amount - a.amount
      );
      const cashedOutCreators = participants.filter((p) => p.amount > 0);
      const extractedCreators = participants.filter((p) => p.extracted > 0);
      const median = Math.floor(cashedOutCreators.length / 2);

      const data = {
        dollarValue: compensationPool.value,
        creatorCount: participants.length,
        totalBankedBuzz: cashedOutCreators.reduce((acc, p) => acc + p.amount, 0),
        extractedCreatorCount: extractedCreators.length,
        cashedOutCreatorCount: cashedOutCreators.length,
        totalExtractedBuzz: extractedCreators.reduce((acc, p) => acc + p.extracted, 0),
        dollarAmountPerThousand: formatToLeastDecimals(getCurrentValue(1000, compensationPool)),
        dollarHighestEarned: formatToLeastDecimals(
          getCurrentValue(cashedOutCreators[0].amount, compensationPool)
        ),
        dollarAverageEarned: formatToLeastDecimals(
          getCurrentValue(
            cashedOutCreators.reduce((acc, p) => acc + p.amount, 0) / cashedOutCreators.length,
            compensationPool
          )
        ),
        dollarMedianEarned: formatToLeastDecimals(
          getCurrentValue(cashedOutCreators[median].amount, compensationPool)
        ),
      };

      return data;
    },
    {
      ttl: CacheTTL.month,
    }
  );

  return data;
};
