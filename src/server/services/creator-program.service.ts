import dayjs from 'dayjs';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { UserTier } from '~/server/schema/user.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import {
  bustFetchThroughCache,
  createCachedObject,
  fetchThroughCache,
} from '~/server/utils/cache-helpers';
import {
  getExtractionFee,
  getPhases as getPhases,
  getWithdrawalFee,
} from '~/server/utils/creator-program.utils';
import { invalidateSession } from '~/server/utils/session-helpers';
import {
  CAP_DEFINITIONS,
  CapDefinition,
  MIN_CAP,
  MIN_CREATOR_SCORE,
  MIN_WITHDRAWAL_AMOUNT,
  PayoutMethods,
  PEAK_EARNING_WINDOW,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { numberWithCommas } from '~/utils/number-helpers';

type UserCapCacheItem = {
  id: number;
  definition: CapDefinition;
  peakEarning: { month: Date; earned: number };
  cap: number;
};
// TODO creator program: Flush this userCapCache on month roll-over
// TODO creator program: bust this cache when a user's subscription changes
const userCapCache = createCachedObject<UserCapCacheItem>({
  key: REDIS_KEYS.CREATOR_PROGRAM.CAPS,
  idKey: 'id',
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
        (type IN ('compensation', 'tip')) -- Generation
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
  ttl: CacheTTL.month,
});

export async function getBankCap(userId: number) {
  return userCapCache.fetch(userId);
}

function getMonthAccount(month?: Date) {
  month ??= new Date();
  return Number(dayjs(month).format('YYYYMM'));
}

// TODO Creator Program: Bust this cache when a user banks buzz
// TODO Creator Program: Flush this cache on month roll-over
export async function getBanked(userId: number) {
  const monthAccount = getMonthAccount();
  const total = await fetchThroughCache(
    `${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`,
    async () => {
      // TODO creator program: We probably should get this from the Buzz service since there might be a delay logging to ClickHouse... Need help from Koen
      const [result] = await clickhouse!.$query<{ banked: number }>`
        SELECT
          SUM(if(fromAccountType = 'user', amount, amount * -1)) as banked
        FROM buzzTransactions
        WHERE (
            (fromAccountId = ${userId} AND fromAccountType = 'user' AND toAccountType = 'creator-program:bank' AND toAccountId = ${monthAccount})
          OR (toAccountId = ${userId} AND fromAccountType = 'creator-program:bank' AND fromAccountId = ${monthAccount})
        )
        AND date > toStartOfMonth(now());
      `;
      return result.banked;
    },
    { ttl: CacheTTL.month }
  );

  return {
    total,
    cap: (await getBankCap(userId))[userId],
  };
}

export async function bustBankedCache(userId: number) {
  bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
}

export async function getCreatorRequirements(userId: number) {
  const [status] = await dbRead.$queryRaw<{ score: number; membership: UserTier }[]>`
    SELECT
    COALESCE(cast((meta->'scores'->'total') as int), 0) as score,
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
    membership: status.membership !== 'free' ? status.membership : false,
  };
}

export async function joinCreatorsProgram(userId: number) {
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
    AND type = 'purchase'
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
  const [result] = await clickhouse!.$query<{ banked: number }>`
    SELECT
      SUM(if(fromAccountType = 'user', amount, amount * -1)) as banked
    FROM buzzTransactions
    WHERE (
        (fromAccountType = 'user' AND toAccountType = 'creator-program:bank' AND toAccountId = ${monthAccount})
      OR (toAccountType = 'user' AND fromAccountType = 'creator-program:bank' AND fromAccountId = ${monthAccount})
    )
    AND date > toStartOfMonth(${month});
  `;
  return result.banked;
}

async function getPoolForecast(month?: Date) {
  month ??= new Date();
  const [result] = await clickhouse!.$query<{ balance: number }>`
    SELECT
      SUM(amount) AS balance
    FROM buzzTransactions
    WHERE toAccountType = 'user'
    AND (
      (type IN ('compensation', 'tip')) -- Generation
      OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
    )
    AND toAccountId != 0
    AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(${month}, 1));
  `;
  return result.balance * (env.CREATOR_POOL_FORECAST_PORTION / 100);
}

export async function getCompensationPool() {
  // TODO creator program: Bust this cache at month roll-over
  const value = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.POOL_VALUE,
    async () => await getPoolValue(),
    { ttl: CacheTTL.month }
  );

  // TODO creator program: Bust this cache when a user banks or extracts buzz
  const current = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE,
    async () => await getPoolSize(),
    { ttl: CacheTTL.month }
  );

  // TODO creator program: Bust this cache at month roll-over
  const forecasted = await fetchThroughCache(
    REDIS_KEYS.CREATOR_PROGRAM.POOL_FORECAST,
    async () => await getPoolForecast(),
    { ttl: CacheTTL.month }
  );

  return {
    value,
    size: {
      current,
      forecasted,
    },
    phases: getPhases(),
  };
}

export async function bankBuzz(userId: number, amount: number) {
  // Check that we're in the banking phase
  const phases = getPhases();
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
    toAccountType: 'creator-program:bank',
    type: TransactionType.Bank,
    description: 'Banked for Creator Program',
  });

  // Bust affected caches
  bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);

  // TODO creators program stretch: Signal pool size update. Need help from Koen?
}

export async function extractBuzz(userId: number) {
  // Check that we're in the extraction phase
  const phases = getPhases();
  if (new Date() < phases.extraction[0]) throw new Error('Extraction phase has not started');
  else if (new Date() > phases.extraction[1]) throw new Error('Extraction phase is closed');

  // Get banked amount
  const banked = await getBanked(userId);
  if (banked.total <= 0) return;

  // Calculate extraction fee
  const fee = await getExtractionFee(banked.total);

  // Charge fee and extract banked amount
  let chargedFee = false;
  const monthAccount = getMonthAccount();
  try {
    // Burn fee
    // TODO creator program: Check that charging the fee and refunding on failure works with Koen
    await createBuzzTransaction({
      amount: fee,
      fromAccountId: monthAccount,
      fromAccountType: 'creator-program:bank',
      toAccountId: 0,
      toAccountType: 'creator-program:bank',
      type: TransactionType.Fee,
      description: 'Extraction fee',
    });
    chargedFee = true;

    // Transfer banked amount
    await createBuzzTransaction({
      amount: banked.total - fee,
      fromAccountId: monthAccount,
      fromAccountType: 'creator-program:bank',
      toAccountId: userId,
      toAccountType: 'user',
      type: TransactionType.Extract,
      externalTransactionId: `extraction-${monthAccount}-${userId}`,
      description: `Extracted from Bank (⚡${numberWithCommas(fee)} fee)`,
    });
  } catch (e) {
    if (chargedFee) {
      // Refund fee
      await createBuzzTransaction({
        amount: fee,
        fromAccountId: 0,
        fromAccountType: 'creator-program:bank',
        toAccountId: monthAccount,
        toAccountType: 'creator-program:bank',
        type: TransactionType.Refund,
        description: 'Extraction fee refund',
      });
    }
    throw e;
  }

  // Bust affected caches
  bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);
}

type UserCashCacheItem = {
  id: number;
  status: 'pending' | 'ready';
  pending: number;
  ready: number;
  withdrawn: number;
  paymentMethod: PayoutMethods;
  withdrawalFee?: {
    type: 'fixed' | 'percent';
    amount: number; // Fixed amount or percent
  };
};
// TODO creator program: Flush this userCashCache on distribution
// TODO creator program: Flush this userCashCache on cash settlement
// TODO creator program: Bust this cache when a user withdraws cash
// TODO creator program: Bust this cache when a user's withdrawal fails
const userCashCache = createCachedObject<UserCashCacheItem>({
  key: REDIS_KEYS.CREATOR_PROGRAM.CASH,
  idKey: 'id',
  lookupFn: async (ids) => {
    if (ids.length === 0 || !clickhouse) return {};

    const statuses = await dbWrite.$queryRawUnsafe<
      { userId: number; status: 'pending' | 'ready' }[]
    >(`
      SELECT
        "userId",
        IIF("tipaltiAccountStatus" = 'Active', 'ready'::text, 'pending'::text) as status
      FROM "UserPaymentConfiguration" uc
      WHERE "userId" IN (${ids.join(',')});
    `);

    // TODO creators program: Need a way to get this from the Buzz service so that we don't need to wait for things to settle in ClickHouse
    const balances = await clickhouse.$query<{ userId: number; pending: number; ready: number }>`
      SELECT
        toAccountId as userId,
        SUM(if(toAccountType = 'cash:pending', if(type = 'withdrawal', -1, 1) * amount, 0) as pending,
        SUM(if(toAccountType = 'cash:settled', if(type = 'withdrawal', -1, 1) * amount, 0) as ready
      FROM buzzTransactions
      WHERE toAccountType IN ('cash:pending', 'cash:settled')
      AND (toAccountId IN (${ids}) OR fromAccountId IN (${ids}))
      GROUP BY userId;
    `;

    const withdrawals = await dbWrite.$queryRawUnsafe<{ userId: number; amount: number }[]>(`
      SELECT
        "userId",
        SUM(amount) as amount
      FROM "CashWithdrawal" cw
      WHERE "userId" IN (${ids.join(',')})
        AND status != 'Failed'
    `);

    // TODO creators program: we need a way to determine the payment method for each user
    const paymentMethods = ids.map((id) => ({ userId: id, method: 'ach' }));

    return Object.fromEntries(
      ids.map((id) => {
        const status = statuses.find((s) => s.userId === id)?.status ?? 'pending';
        const { pending, ready } = balances.find((b) => b.userId === id) ?? {
          pending: 0,
          ready: 0,
        };
        const withdrawn = withdrawals.find((w) => w.userId === id)?.amount ?? 0;
        const paymentMethod = (paymentMethods.find((m) => m.userId === id)?.method ??
          'ach') as PayoutMethods;
        return [id, { id, status, pending, ready, withdrawn, paymentMethod }];
      })
    );
  },
  appendFn: async (items) => {
    // Append withdrawal fees
    for (const item of items) {
      item.withdrawalFee = WITHDRAWAL_FEES[item.paymentMethod];
    }
  },
  ttl: CacheTTL.month,
});
export async function getCash(userId: number) {
  return (await userCashCache.fetch(userId))[userId];
}

export async function getWithdrawalHistory(userId: number) {
  const transactions = await dbWrite.cashWithdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      method: true,
      amount: true,
      status: true,
      note: true,
    },
  });

  return transactions;
}

export async function withdrawCash(userId: number, amount: number) {
  // Check setup for withdrawal
  const cash = await getCash(userId);
  if (cash.status === 'pending') throw new Error('Payment setup is pending');

  // Check that amount is valid
  if (amount < MIN_WITHDRAWAL_AMOUNT) throw new Error('Amount is below minimum');

  // Determine withdrawal amount
  const fee = getWithdrawalFee(amount, cash.paymentMethod);
  const toWithdraw = amount - fee;

  // Create withdrawal record
  const [{ id }] = await dbWrite.$queryRaw<{ id: number }[]>`
    INSERT INTO "CashWithdrawal" ("userId", "amount", "fee", "status")
    VALUES (${userId}, ${toWithdraw}, ${fee}, 'Started')
    RETURNING id;
  `;

  // Burn full amount
  const { transactionId } = await createBuzzTransaction({
    amount,
    fromAccountId: userId,
    fromAccountType: 'user',
    toAccountId: 0,
    toAccountType: 'cash:settled',
    type: TransactionType.Withdrawal,
    description: 'Withdrawal request',
  });

  // Update withdrawal record
  await dbWrite.$executeRaw`
    UPDATE "CashWithdrawal"
    SET "transactionId" = ${transactionId}, status = 'Burned'
    WHERE id = ${id};
  `;

  // Create tipalti payment
  // TODO creator program: Luis implement request to tipalti

  // Update withdrawal record
  await dbWrite.$executeRaw`
    UPDATE "CashWithdrawal"
    SET status = 'Submitted'
    WHERE id = ${id};
  `;

  // Bust affected caches
  userCashCache.bust(userId);
}
