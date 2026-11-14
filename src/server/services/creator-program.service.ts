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
import { decodeRedisString } from '~/server/redis/buffer-decode';
import type { BuzzCreatorProgramType, BuzzSpendType } from '~/shared/constants/buzz.constants';
import {
  TransactionType,
  buzzBankTypes,
  buzzBankTypesSql,
} from '~/shared/constants/buzz.constants';
import type {
  CashWithdrawalMetadataSchema,
  CompensationPoolInput,
  ModCashAdjustmentInput,
  UpdateCashWithdrawalSchema,
} from '~/server/schema/creator-program.schema';
import type { UserTier } from '~/server/schema/user.schema';
import {
  createBuzzTransaction,
  getCounterPartyBuzzTransactions,
  getTopContributors,
  getTransactionByExternalId,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import {
  getBankableAmount,
  getBankableLedger,
  PEAK_EARNING_PREDICATE_SQL,
  PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL,
  RECEIVED_FROM_USER_SQL,
  SENT_TO_USER_SQL,
  withBankedThisMonth,
} from '~/server/services/creator-program-bankable';
import { createNotification } from '~/server/services/notification.service';
import { getHighestPaidTierSubscription } from '~/server/services/subscriptions.service';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';
import { payToTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import { assertNoPayoutHold } from '~/server/services/creator-program-prepayout-review/hold';
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
  generateWithdrawalRefCode,
  getWithdrawalFee,
  parseRefCodeToWithdrawalId,
} from '~/server/utils/creator-program.utils';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { handleLogError, throwBadRequestError } from '~/server/utils/errorHandling';
import { refreshSession } from '~/server/auth/session-invalidation';
import type { CapDefinition } from '~/shared/constants/creator-program.constants';
import {
  BANKABLE_CUTOVER,
  CAP_DEFINITIONS,
  EXTRACTION_FEE_DESCRIPTION,
  MIN_CREATOR_SCORE,
  MIN_WITHDRAWAL_AMOUNT,
  PEAK_EARNING_WINDOW,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { getCapForDefinition } from '~/shared/utils/creator-program.utils';
import { creatorScoreCategorySumSql } from '~/shared/utils/creator-score';
import { Flags } from '~/shared/utils/flags';
import { CashWithdrawalMethod, CashWithdrawalStatus } from '~/shared/utils/prisma/enums';
import { withRetries } from '~/utils/errorHandling';
import { signalClient } from '~/utils/signal-client';
import { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import { formatToLeastDecimals } from '~/utils/number-helpers';
import { userUpdateCounter } from '~/server/prom/client';
import { refundExternalTransactionId } from '~/server/services/buzz-refund-id';
import { TRPCError } from '@trpc/server';

type UserCapCacheItem = {
  id: number;
  definition: CapDefinition;
  peakEarning: { month: Date; earned: number };
  cap: number;
  countsCompensation: boolean;
};

const getBankAccountType = (_buzzType?: BuzzSpendType): BuzzCreatorProgramType => {
  return 'creatorProgramBank';
};

const createUserCapCache = () => {
  return createCachedObject<UserCapCacheItem>({
    key: REDIS_KEYS.CREATOR_PROGRAM.CAPS,
    idKey: 'id',
    dontCacheFn: (data) => !data?.cap,
    cacheNotFound: false,
    staleWhileRevalidate: false,
    debounceTime: 1, // Minimum: lookup reads the primary and ClickHouse, not a replica.
    lookupFn: async (ids) => {
      if (ids.length === 0 || !clickhouse) return {};

      // Get the highest tier for each user across all active subscriptions (regardless of
      // buzzType). Buzz-purchased memberships are excluded: they confer no Creator Program
      // benefit, so they must not raise a banking cap either.
      const subscriptions = await dbWrite.$queryRawUnsafe<{ userId: number; tier: UserTier }[]>(`
        SELECT DISTINCT ON (cs."userId")
          cs."userId",
          (p.metadata->>'tier') as tier
        FROM "CustomerSubscription" cs
        JOIN "Product" p ON p.id = cs."productId"
        WHERE cs."userId" IN (${ids.join(',')})
          AND (p.metadata->>'buzzPurchase') IS DISTINCT FROM 'true'
        ORDER BY cs."userId",
          CASE (p.metadata->>'tier')
            WHEN 'gold' THEN 4
            WHEN 'silver' THEN 3
            WHEN 'bronze' THEN 2
            WHEN 'founder' THEN 1
            ELSE 0
          END DESC;
      `);

      // Pool forecasts and buzz.service's `earnedCache` still count generation compensation.
      const countsCompensation = new Date() < BANKABLE_CUTOVER;
      const peakEarningPredicate = countsCompensation
        ? PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL
        : PEAK_EARNING_PREDICATE_SQL;
      // A month counts what a user paid the creator only beyond everything the creator sent that
      // user in the window up to now, so Buzz passed back and forth cannot raise the peak.
      const peakEarnings = await clickhouse.$query<{ id: number; month: Date; earned: number }>`
        SELECT id, month, gross - returned AS earned
        FROM (
          SELECT
            toAccountId as id,
            toStartOfMonth(date) as month,
            SUM(amount) as gross
          FROM buzzTransactions
          WHERE ${peakEarningPredicate}
          AND toAccountType IN (${buzzBankTypesSql})
          AND toAccountId IN (${ids})
          AND toStartOfMonth(date) >= toStartOfMonth(subtractMonths(now(), ${PEAK_EARNING_WINDOW}))
          AND toStartOfMonth(date) < toStartOfMonth(now())
          GROUP BY month, toAccountId
        ) AS earnings
        LEFT JOIN (
          SELECT received.id AS id, received.month AS month, SUM(least(received.amount, sent.amount)) AS returned
          FROM (
            SELECT toAccountId AS id, toStartOfMonth(date) AS month, fromAccountId AS counterparty, SUM(amount) AS amount
            FROM buzzTransactions
            WHERE ${peakEarningPredicate} AND ${RECEIVED_FROM_USER_SQL}
            AND toAccountType IN (${buzzBankTypesSql})
            AND toAccountId IN (${ids})
            AND toStartOfMonth(date) >= toStartOfMonth(subtractMonths(now(), ${PEAK_EARNING_WINDOW}))
            AND toStartOfMonth(date) < toStartOfMonth(now())
            GROUP BY id, month, counterparty
          ) AS received
          INNER JOIN (
            SELECT fromAccountId AS id, toAccountId AS counterparty, SUM(amount) AS amount
            FROM buzzTransactions
            WHERE ${SENT_TO_USER_SQL}
            AND fromAccountId IN (${ids})
            AND toStartOfMonth(date) >= toStartOfMonth(subtractMonths(now(), ${PEAK_EARNING_WINDOW}))
            GROUP BY id, counterparty
          ) AS sent ON sent.id = received.id AND sent.counterparty = received.counterparty
          GROUP BY id, month
        ) AS netted USING (id, month)
        ORDER BY earned DESC
        LIMIT 1 BY id;
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

          const cap = getCapForDefinition(definition, peakEarning.earned);

          return [s.userId, { id: s.userId, definition, peakEarning, cap, countsCompensation }];
        })
      );
    },
    ttl: CacheTTL.day,
  });
};

let _userCapCache: ReturnType<typeof createUserCapCache> | undefined;
export function getUserCapCache() {
  if (!_userCapCache) {
    _userCapCache = createUserCapCache();
  }
  return _userCapCache;
}

export async function getBankCap(userId: number) {
  const cache = getUserCapCache();
  const caps = await cache.fetch(userId);
  // A cap cached before the cutover can outlive the rollover job's flush by up to its TTL.
  if (caps[userId] && caps[userId].countsCompensation !== false && new Date() >= BANKABLE_CUTOVER) {
    await cache.bust(userId);
    return cache.fetch(userId);
  }
  return caps;
}

export function getMonthAccount(month?: Date) {
  month ??= new Date();
  return Number(dayjs(month).format('YYYYMM'));
}

async function fetchBankedPerType(userId: number) {
  const monthAccount = getMonthAccount();
  const bankAccountType = getBankAccountType();
  const results = await Promise.all(
    buzzBankTypes.map(async (buzzType) => {
      const result = await getCounterPartyBuzzTransactions({
        accountId: monthAccount,
        accountType: bankAccountType,
        counterPartyAccountId: userId,
        counterPartyAccountType: buzzType,
      });
      return { buzzType, total: result.totalBalance ?? 0 };
    })
  );

  return Object.fromEntries(results.map((r) => [r.buzzType, r.total])) as Record<
    (typeof buzzBankTypes)[number],
    number
  >;
}

/**
 * Pass `fresh` wherever the total decides how much Buzz moves: the cache can serve a total from
 * before the last deposit while another reader is refreshing it.
 */
export async function getBankedBalance(userId: number, { fresh = false } = {}) {
  const perType = fresh
    ? await fetchBankedPerType(userId)
    : await fetchThroughCache(
        `${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`,
        () => fetchBankedPerType(userId),
        { ttl: CacheTTL.day }
      );

  const total = Object.values(perType).reduce((sum, v) => sum + v, 0);
  const capData = (await getBankCap(userId))[userId];

  return {
    perType,
    total,
    cap: capData,
  };
}

/** For display. `bankBuzz` reads the bankable amount itself so a ClickHouse failure blocks it. */
export async function getBanked(userId: number) {
  const [balance, ledger] = await Promise.all([
    getBankedBalance(userId),
    fetchThroughCache(
      `${REDIS_KEYS.CREATOR_PROGRAM.BANKABLE}:${userId}`,
      () => getBankableLedger(userId),
      { ttl: CacheTTL.sm }
    ).catch((error: Error) => {
      handleLogError(error, 'creator-program:bankable-amount');
      return null;
    }),
  ]);
  const bankable = ledger && withBankedThisMonth(ledger, balance.total);

  return { ...balance, bankable };
}
export async function flushBankedCache() {
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:*`);
}

export async function getCreatorRequirements(userId: number) {
  const [status] = await dbWrite.$queryRaw<
    { score: number; membership: UserTier; onboarding: number }[]
  >`
    SELECT
    -- We are doing greatest in case the meta->'scores'->'total' is not properly computated.
    -- Noticed a few cases where it was different than the total sum (lower). Safeguard here.
    GREATEST(
      ${Prisma.raw(creatorScoreCategorySumSql('u.meta'))},
      COALESCE((meta->'scores'->'total')::numeric, 0)
    ) as score,
    (
      SELECT p.metadata->>'tier'
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      WHERE status IN ('incomplete', 'active') AND cs."userId" = u.id
      LIMIT 1
    ) as membership,
    u.onboarding as onboarding
    FROM "User" u
    WHERE id = ${userId};
  `;

  // A member whose subscription lapsed keeps the onboarding flag (we don't strip
  // it), so surface a lapsed signal for the UI. Uses the same gate as the shop /
  // banking so all three agree on what "active" means.
  const joined = Flags.hasFlag(status.onboarding, OnboardingSteps.CreatorProgram);
  const membershipLapsed = joined && !(await hasValidCreatorMembership(userId));

  return {
    score: {
      min: MIN_CREATOR_SCORE,
      current: status.score,
    },
    membership: status.membership !== 'free' ? status.membership : undefined,
    validMembership:
      // We will not support founder tier.
      status.membership !== 'free' && status.membership !== 'founder' ? status.membership : false,
    membershipLapsed,
  };
}

// Whether a user currently holds a valid Creator Program membership — an active,
// good-standing PAID subscription on a supported tier. Uses getHighestPaidTierSubscription
// so it honors membership on ANY buzzType (yellow/green/blue paid + referral
// grants), matching how session-user resolves tier. Checking a single buzzType
// here would lock out .green/.red members and referral-granted members whose paid
// sub isn't yellow.
export async function hasValidCreatorMembership(userId: number) {
  // Paid-only: a Buzz-purchased perks membership does not grant Creator Program access.
  const subscription = await getHighestPaidTierSubscription(userId);
  const tier = subscription?.tier;
  return !!tier && tier !== 'free' && tier !== 'founder';
}

// Batched read-time membership gate lives in a dependency-light module so the
// donation-goals lookup can reuse it without pulling this heavy graph. Re-exported
// here for the existing metric-privacy callers. `hasValidCreatorMembershipCached` is
// the single-user, cache-backed variant for read-time display gating (byte-identical
// validity to `hasValidCreatorMembership`, served from the shared read-through cache).
export {
  getValidCreatorMembershipMap,
  hasValidCreatorMembershipCached,
  getUserMetricPrivacyDefaultsMap,
} from '~/server/services/creator-membership.service';

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

  userUpdateCounter?.inc({ location: 'creator-program.service:completeOnboarding' });

  // Best-effort — the `onboarding` bitmask write above has already committed, and it is the SAME
  // column `completeOnboardingHandler` writes, so an unguarded bust here fails a joined-and-recorded
  // membership with a 500 and invites the client to re-join. Staleness is bounded by the session
  // entry's own TTL. Logged, never swallowed silently.
  await refreshSession(userId, { caller: 'membership' }).catch(handleLogError);
}

async function getPoolValue(month?: Date) {
  month ??= new Date();

  const results = await clickhouse!.$query<{ balance: number }>`
    SELECT
        SUM(amount) / 1000 AS balance
    FROM buzzTransactions
    WHERE toAccountType IN (${buzzBankTypesSql})
    AND (
      type = 'purchase'
      OR (type = 'redeemable' AND description LIKE 'Redeemed code SH-%')
      OR (type = 'redeemable' AND description LIKE 'Redeemed code KG-%')
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
    accountType: 'creatorProgramBank',
  });

  return account[0]?.balance ?? 0;
}

async function getPoolForecast(month?: Date) {
  month ??= new Date();

  const [result] = await clickhouse!.$query<{ balance: number }>`
    SELECT
      SUM(amount) AS balance
    FROM buzzTransactions
    WHERE toAccountType IN (${buzzBankTypesSql})
    AND (
      (type IN ('compensation','tip')) -- Generation
      OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
    )
    AND toAccountId != 0
    AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(${month}, 1));
  `;
  return result.balance * (env.CREATOR_POOL_FORECAST_PORTION / 100);
}

function isBankingClosed(phases: ReturnType<typeof getPhases>) {
  return dayjs.utc().isAfter(dayjs.utc(phases.bank[1]));
}

// After the deadline no new Buzz can be banked, so the pool can only shrink; the forecasted size
// can't exceed current, keeping every derived forecast at or above the banked value.
function clampForecastAfterBankingDeadline(
  size: { current: number; forecasted: number },
  phases: ReturnType<typeof getPhases>
) {
  if (!isBankingClosed(phases)) return size;
  return { ...size, forecasted: Math.min(size.forecasted, size.current) };
}

export async function getCompensationPool({ month }: CompensationPoolInput = {}) {
  if (month) {
    // Skip caching if fetching specific month
    const phases = getPhases({ month, flip: (await getFlippedPhaseStatus()) === 'true' });
    return {
      value: await getPoolValue(month),
      size: clampForecastAfterBankingDeadline(
        {
          current: await getPoolSize(month),
          forecasted: await getPoolForecast(month),
        },
        phases
      ),
      phases,
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

  // TODO: Remove flip when we're ready to go live
  const phases = getPhases({ flip: (await getFlippedPhaseStatus()) === 'true' });

  return {
    value,
    size: clampForecastAfterBankingDeadline({ current, forecasted }, phases),
    phases,
  };
}

export async function bustCompensationPoolCache() {
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_VALUE);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_FORECAST);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.PREV_MONTH_STATS);
  // Clean up legacy per-type cache keys from before pool unification
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.POOL_VALUE}:*`);
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE}:*`);
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.POOL_FORECAST}:*`);
  await clearCacheByPattern(`${REDIS_KEYS.CREATOR_PROGRAM.PREV_MONTH_STATS}:*`);
}

async function getFlippedPhaseStatus() {
  return decodeRedisString(await sysRedis.get(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES));
}

/**
 * The keyed-charge helpers, loaded at the call site and only for a keyed request: imported at the
 * top of this file they join its import cycle (the same reason `refundTransactionOnce` is loaded
 * in `withdrawCash`).
 */
async function loadKeyedCharge() {
  const [charge, lock] = await Promise.all([
    import('~/server/services/buzz-keyed-charge'),
    import('~/server/services/buzz-charge-lock'),
  ]);
  return { ...charge, ...lock };
}

/**
 * The ledger id of one deposit into the bank. With the client's key (a uuid, minted once per
 * deposit and resent on its retries) it is the same on every retry, so the ledger holds one
 * deposit for it. The user id comes first and has no '-', so one user's key never names another
 * user's deposit. Without a key there is no id (the ledger client mints one per call, no dedup).
 */
export function bankDepositTransactionId(userId: number, idempotencyKey: string) {
  return `creator-bank-deposit-${userId}-${idempotencyKey}`;
}

/** The ledger id of one cash withdrawal's burn, as `bankDepositTransactionId` for a deposit. */
export function cashWithdrawalTransactionId(userId: number, idempotencyKey: string) {
  return `creator-cash-withdrawal-${userId}-${idempotencyKey}`;
}

export async function bankBuzz(
  userId: number,
  amount: number,
  buzzType: BuzzSpendType,
  idempotencyKey?: string
) {
  if (buzzType === 'blue') {
    throw throwBadRequestError('You cannot bank Blue Buzz.');
  }

  // Check that we're in the banking phase
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }

  // Banking claims real pool money, so it requires a confirmed, unexpired paid
  // membership — stricter than the shop's hasValidCreatorMembership, which also
  // accepts incomplete/renewing subs. Like the shop gate it is buzzType-agnostic
  // (any buzzType) but rejects free/founder tiers.
  const activeMembership = await dbWrite.customerSubscription.findFirst({
    where: { userId, status: 'active', currentPeriodEnd: { gt: new Date() } },
    select: { product: { select: { metadata: true } } },
  });
  // safeParse: malformed/missing product metadata falls through to the clean 400
  // below instead of throwing an uncaught ZodError (500).
  const parsedMeta = activeMembership
    ? subscriptionProductMetadataSchema.safeParse(activeMembership.product.metadata)
    : undefined;
  const membershipTier = parsedMeta?.success ? parsedMeta.data[env.TIER_METADATA_KEY] : undefined;
  if (
    !membershipTier ||
    membershipTier === 'free' ||
    membershipTier === 'founder' ||
    parsedMeta?.data?.buzzPurchase
  )
    throw throwBadRequestError('An active Creator Program membership is required to bank Buzz.');

  // TODO: Remove flip when we're ready to go live
  const phases = getPhases({ flip: (await getFlippedPhaseStatus()) === 'true' });
  if (isBankingClosed(phases)) throw new Error('Banking phase is closed');

  const monthAccount = getMonthAccount();
  const bankAccountType = getBankAccountType(buzzType);
  // A function, not a value: `amount` is clamped below, and the deposit sends the clamped amount.
  const deposit = () => ({
    amount,
    fromAccountId: userId,
    fromAccountType: buzzType,
    toAccountId: monthAccount,
    toAccountType: bankAccountType,
    type: TransactionType.Bank,
    description: 'Banked for Creator Program',
  });
  const keyedId =
    idempotencyKey !== undefined ? bankDepositTransactionId(userId, idempotencyKey) : undefined;
  const declinedMessage = 'Unable to bank this amount';
  const keyed = keyedId !== undefined ? await loadKeyedCharge() : undefined;

  // The limits are read and spent in one critical section: two deposits racing past the same
  // check would bank twice the remaining amount. It also keeps two requests with one key from
  // depositing at the same time.
  const deposited = await withDistributedLock(
    { key: `creator-program:bank:${userId}`, ttl: 30, autoRenew: true, maxRetries: 0 },
    async () => {
      // With a key, a deposit the ledger already holds is this action's, from an earlier request
      // whose answer was lost. Looked up BEFORE the cap and bankable checks: they read a banked
      // total that already includes it, and would clamp or refuse a retry whose Buzz moved.
      if (keyedId !== undefined && keyed) {
        let held: unknown;
        try {
          held = await getTransactionByExternalId(keyedId);
        } catch (lookupError) {
          throw keyed.paymentOutcomeUnknown(
            { externalTransactionId: keyedId, userId, amount },
            'deposit lookup before checks failed',
            { lookupError }
          );
        }
        if (held) {
          // Resends under the held id (moves nothing) and refuses a deposit since refunded. The
          // amount is not compared: the earlier attempt may have banked less than was asked (the
          // cap or the bankable amount clamps it), and this retry resends the asked amount. The
          // banked total is read from the ledger, so the held deposit's own amount is what counts.
          await keyed.chargeByExternalId(
            { ...deposit(), externalTransactionId: keyedId },
            { reusable: true, declinedMessage, matchAmount: false }
          );
          await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
          return true;
        }
      }

      const banked = await getBankedBalance(userId, { fresh: true });
      if (banked.cap.cap < banked.total + amount) amount = banked.cap.cap - banked.total;
      const bankable = await getBankableAmount(userId, banked.total);
      if (bankable) {
        if (bankable.remaining <= 0)
          throw throwBadRequestError(
            'You have no bankable Buzz left. See the bankable Buzz breakdown for what counts.'
          );
        amount = Math.min(amount, bankable.remaining);
      }
      if (amount <= 0) throw new Error('Amount exceeds cap');

      if (keyedId !== undefined && keyed) {
        // An unknown outcome is resent once under the same id; a resend that fails too is "may
        // have gone through" and the client keeps its key. The ledger is the deposit's only
        // record (the banked total is read from it), so there is no row to write under a lock.
        await keyed.chargeByExternalId(
          { ...deposit(), externalTransactionId: keyedId },
          { reusable: true, declinedMessage }
        );
      } else {
        await createBuzzTransaction(deposit());
      }

      await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
      return true;
    }
  );
  // Null also means Redis could not take the lock, not only that another deposit holds it.
  if (!deposited) {
    const message = "Couldn't start your deposit. Try again in a moment.";
    // With a key, the request holding the lock may be this same deposit: a 429, so the client
    // keeps the key and its next attempt is answered from that deposit instead of making another.
    if (keyedId !== undefined) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
    throw throwBadRequestError(message);
  }

  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);

  const compensationPool = await getCompensationPool();
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

  // Get banked amounts across all types
  const banked = await getBankedBalance(userId, { fresh: true });
  if (banked.total <= 0) return;

  // Calculate extraction fee on combined total
  const fee = getExtractionFee(banked.total);

  // Extract each type that has a positive balance back to its original type
  const monthAccount = getMonthAccount();
  const bankAccountType = getBankAccountType();
  for (const buzzType of buzzBankTypes) {
    const amount = banked.perType[buzzType] ?? 0;
    if (amount <= 0) continue;

    await createBuzzTransaction({
      amount,
      fromAccountId: monthAccount,
      fromAccountType: bankAccountType,
      toAccountId: userId,
      toAccountType: buzzType,
      type: TransactionType.Extract,
      externalTransactionId: `extraction-${monthAccount}-${userId}-${buzzType}`,
      description: `Extracted from Bank`,
    });
  }

  if (fee > 0) {
    // Burn fee proportionally from each type (floor to avoid overcharging, last type gets remainder)
    let remainingFee = fee;
    const typesWithBalance = buzzBankTypes.filter((bt) => (banked.perType[bt] ?? 0) > 0);

    for (let i = 0; i < typesWithBalance.length; i++) {
      const buzzType = typesWithBalance[i];
      const amount = banked.perType[buzzType] ?? 0;

      // Last type gets the remainder to avoid rounding errors
      const typeFee =
        i === typesWithBalance.length - 1
          ? remainingFee
          : Math.min(Math.floor((amount / banked.total) * fee), remainingFee);

      if (typeFee <= 0) continue;
      remainingFee -= typeFee;

      await createBuzzTransaction({
        amount: typeFee,
        fromAccountId: userId,
        fromAccountType: buzzType,
        toAccountId: 0,
        type: TransactionType.Fee,
        externalTransactionId: `extraction-fee-${monthAccount}-${userId}-${buzzType}`,
        description: EXTRACTION_FEE_DESCRIPTION,
      });
    }
  }

  // Bust affected caches
  await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  await bustFetchThroughCache(REDIS_KEYS.CREATOR_PROGRAM.POOL_SIZE);

  const compensationPool = await getCompensationPool();
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
  debounceTime: 1, // Minimum: lookup reads the primary and ClickHouse, not a replica.
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
          accountType: 'cashPending',
        });
        const settled = await getUserBuzzAccount({
          accountId: id,
          accountType: 'cashSettled',
        });
        return {
          id,
          pending: pending[0]?.balance ?? 0,
          ready: settled[0]?.balance ?? 0,
        };
      })
    );

    const withdrawals = await dbWrite.$queryRawUnsafe<{ userId: number; amount: number }[]>(`
      SELECT
        "userId",
        SUM(amount)::INT as amount
      FROM "CashWithdrawal" cw
      WHERE "userId" IN (${ids.join(',')})
        AND status NOT IN ('Rejected', 'Canceled', 'FailedFee', 'Reclaimed')
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

const MAX_REF_CODE_ATTEMPTS = 5;

/**
 * The refCode this withdrawal is (or will be) sent to Tipalti under, stored before any send.
 * Tipalti relies on the refCode to refuse a duplicate payment, so a withdrawal that already has
 * one must always reuse it: generating a fresh code on a re-send would defeat that guard.
 */
export async function ensureWithdrawalRefCode(withdrawalId: string, userId: number) {
  const stored = async () => {
    const { metadata } = await dbWrite.cashWithdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
      select: { metadata: true },
    });
    return (metadata as CashWithdrawalMetadataSchema | null)?.paymentRefCode || undefined;
  };

  const existing = await stored();
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_REF_CODE_ATTEMPTS; attempt++) {
    const candidate = generateWithdrawalRefCode(userId);
    // FailedFee rows carry a copy of their parent's code, so this covers them too.
    const taken = await dbWrite.cashWithdrawal.count({
      where: { userId, metadata: { path: ['paymentRefCode'], equals: candidate } },
    });
    if (taken) continue;

    // Conditional on no code yet: a concurrent caller that stored one first wins, and we reuse it.
    // shortcut: two concurrent withdrawals by one user drawing the same candidate between the
    // count and this write is not locked against (odds ~1 in 36^random-length).
    const updated = await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('paymentRefCode', ${candidate}::text)
      WHERE id = ${withdrawalId} AND (metadata->>'paymentRefCode') IS NULL;
    `;
    if (updated) return candidate;

    const winner = await stored();
    if (winner) return winner;
    throw new Error(`Could not store a refCode for withdrawal ${withdrawalId}`);
  }

  throw new Error(`Could not generate a unique refCode for withdrawal ${withdrawalId}`);
}

/**
 * The cash withdrawal a Tipalti event's refCode belongs to. Matches the exact refCode we stored
 * when sending; rows from before codes were stored fall back to the cuid prefix the old code
 * embedded. Refuses (throws) when more than one row matches, rather than guessing.
 */
export async function findCashWithdrawalByRefCode(refCode: string) {
  // Only the userId is needed for the exact match, so legacy codes the strict parser rejects
  // (e.g. `CW<uid>:<id>`) still match the code stored for them.
  const userId = Number(/^CW(\d+)/.exec(refCode)?.[1]);
  if (!userId) throw new Error(`Invalid withdrawal ref code: ${refCode}`);
  // FailedFee rows copy their parent's metadata, refCode included, and Reclaimed rows are
  // moderator adjustments; neither was ever sent to Tipalti, and both refund if updated.
  const scope = {
    userId,
    status: { notIn: [CashWithdrawalStatus.FailedFee, CashWithdrawalStatus.Reclaimed] },
  };

  let candidates = await dbWrite.cashWithdrawal.findMany({
    where: { ...scope, metadata: { path: ['paymentRefCode'], equals: refCode } },
  });

  if (!candidates.length) {
    const { idPart } = parseRefCodeToWithdrawalId(refCode);
    // A row that stored a different code was sent under that code, so it cannot be this payment.
    candidates = (
      await dbWrite.cashWithdrawal.findMany({ where: { ...scope, id: { startsWith: idPart } } })
    ).filter((row) => !(row.metadata as CashWithdrawalMetadataSchema | null)?.paymentRefCode);
  }

  if (candidates.length > 1) {
    await logToAxiom(
      {
        type: 'error',
        name: 'tipalti-refcode-ambiguous',
        refCode,
        candidateIds: candidates.map((row) => row.id),
      },
      'webhooks'
    ).catch(() => null);
    throw new Error(`Ambiguous Tipalti refCode ${refCode}: ${candidates.length} withdrawals match`);
  }

  if (!candidates.length)
    throw new Error(`Withdrawal request not found for transferId: ${refCode}`);
  return candidates[0];
}

export async function withdrawCash(userId: number, amount: number, idempotencyKey?: string) {
  // Check setup for withdrawal
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
  });

  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwBadRequestError('User is banned from the Creator Program');
  }
  await assertNoPayoutHold(userId);

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
  const method = userPaymentConfiguration.tipaltiWithdrawalMethod;

  // We will use this to keep track of our progress in the code below:
  const data = {
    withdrawalId: '',
    transactionId: '',
    paymentBatchId: '',
    paymentRefCode: '',
    updated: false,
  };

  if (idempotencyKey !== undefined) {
    const recorded = await burnAndRecordKeyedWithdrawal({
      userId,
      amount,
      toWithdraw,
      fee,
      method,
      ready: cash.ready,
      externalTransactionId: cashWithdrawalTransactionId(userId, idempotencyKey),
    });
    // An earlier request with this key recorded the withdrawal and sent (or is sending) it.
    if (!recorded.created) return;
    data.withdrawalId = recorded.id;
    data.transactionId = recorded.transactionId;
  }

  try {
    if (idempotencyKey === undefined) {
      // Create withdrawal record
      const { id } = await dbWrite.cashWithdrawal.create({
        data: {
          userId,
          amount: toWithdraw,
          fee,
          status: CashWithdrawalStatus.InternalValue,
          method,
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
        fromAccountType: 'cashSettled',
        toAccountId: 0,
        toAccountType: 'yellow',
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
    }
    const id = data.withdrawalId;

    // Create tipalti payment
    const refCode = await ensureWithdrawalRefCode(id, userId);

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
      // We failed at creating the Tipalti payment. We should refund the user their buzz.
      // Loaded here so the refund helper stays out of this service's import cycle.
      const { refundTransactionOnce } = await import('~/server/services/buzz-prefix-refund');
      await withRetries(async () => {
        await refundTransactionOnce(
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

/**
 * A keyed withdrawal's burn and its CashWithdrawal row, each exactly once per key.
 *
 * The burn is charged under `externalTransactionId` outside any transaction (`chargeByExternalId`:
 * looked up first, so a retry whose burn landed continues from it; an unknown outcome resent once
 * under the same id). Then a short transaction under the key's lock: a row already holding this
 * burn means an earlier request with the key recorded the withdrawal (`created: false`); a burn
 * refunded meanwhile is refused; otherwise the row is written here, holding the burn's id. A row
 * that fails to write has its burn refunded under the same lock unless another request recorded it.
 *
 * For a row that already exists: sent to Tipalti (it has a payment batch) is done; still
 * `InternalValue` with no batch is another request with the key in flight, "may have gone through";
 * anything else was undone (the failure path cancels it after refunding the burn), a 400.
 */
async function burnAndRecordKeyedWithdrawal({
  userId,
  amount,
  toWithdraw,
  fee,
  method,
  ready,
  externalTransactionId,
}: {
  userId: number;
  amount: number;
  toWithdraw: number;
  fee: number;
  method: CashWithdrawalMethod;
  /** The creator's settled cash (`getCash().ready`). */
  ready: number;
  externalTransactionId: string;
}): Promise<{ created: false } | { created: true; id: string; transactionId: string }> {
  const {
    chargeByExternalId,
    paymentOutcomeUnknown,
    PAYMENT_REFUNDED_MESSAGE,
    CHARGE_LOCKED_READ,
    CHARGE_LOCKED_REFUND,
    recordStepError,
    refundUnlessRecorded,
    withChargeKeyLock,
    findChargeWithRetry,
  } = await loadKeyedCharge();

  // A new burn is never for more than the cash ready to withdraw (the ledger's balance check is the
  // other guard). Not for a burn this key already holds: the ready figure may already exclude it,
  // and refusing would strand that burn. So before refusing, the key's burn is looked up, with
  // retries since the ledger read can lag its write.
  if (
    amount > ready &&
    !(await findChargeWithRetry(
      externalTransactionId,
      { userId, amount },
      'withdrawal lookup before the ready check'
    ))
  )
    throw throwBadRequestError('This amount is more than your cash ready to withdraw.');

  const { transactionId } = await chargeByExternalId(
    {
      amount,
      fromAccountId: userId,
      fromAccountType: 'cashSettled',
      toAccountId: 0,
      toAccountType: 'yellow',
      type: TransactionType.Withdrawal,
      description: 'Withdrawal request',
      externalTransactionId,
    },
    { reusable: true, declinedMessage: 'Unable to withdraw this amount' }
  );

  const context = { userId, amount };
  const outcomeContext = { externalTransactionId, ...context };
  // `transactionId` is unique on CashWithdrawal; scoped to the user as well.
  const findRecorded = (tx: Prisma.TransactionClient) =>
    tx.cashWithdrawal.findFirst({
      where: { userId, transactionId },
      select: { id: true, status: true, metadata: true },
    });
  const isRefunded = async () =>
    !!(await getTransactionByExternalId(
      refundExternalTransactionId(transactionId),
      CHARGE_LOCKED_READ
    ));

  let recordFailed = false;
  let recorded: Awaited<ReturnType<typeof findRecorded>> | { id: string; created: true };
  try {
    recorded = await withChargeKeyLock(externalTransactionId, context, async (tx) => {
      const existing = await findRecorded(tx);
      if (existing) return existing;
      let refunded: boolean;
      try {
        refunded = await isRefunded();
      } catch (lookupError) {
        throw paymentOutcomeUnknown(outcomeContext, 'refund check before recording failed', {
          lookupError,
        });
      }
      if (refunded) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
      try {
        const { id } = await tx.cashWithdrawal.create({
          data: {
            userId,
            amount: toWithdraw,
            fee,
            status: CashWithdrawalStatus.InternalValue,
            method,
            transactionId,
          },
          select: { id: true },
        });
        return { id, created: true as const };
      } catch (error) {
        recordFailed = true;
        throw error;
      }
    });
  } catch (error) {
    if (!recordFailed) throw recordStepError(error, outcomeContext);
    await refundUnlessRecorded(externalTransactionId, context, {
      isRecorded: async (tx) => !!(await findRecorded(tx)),
      isRefunded,
      refund: () =>
        refundTransaction(
          transactionId,
          'Failed to record your withdrawal request.',
          undefined,
          CHARGE_LOCKED_REFUND
        ),
    });
    throw error;
  }

  if ('created' in recorded) return { created: true, id: recorded.id, transactionId };
  if ((recorded.metadata as CashWithdrawalMetadataSchema | null)?.paymentBatchId)
    return { created: false };
  if (recorded.status === CashWithdrawalStatus.InternalValue)
    throw paymentOutcomeUnknown(outcomeContext, 'another request with this key is sending it');
  throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
}

export async function getPoolParticipants(month?: Date, includeNegativeAmounts = false) {
  month ??= new Date();

  const bankAccountType = getBankAccountType();
  const monthAccount = getMonthAccount(month);
  const participants = await clickhouse!.$query<{
    userId: number;
    amount: number;
    extracted: number;
  }>`
    SELECT
      if(toAccountType = '${bankAccountType}', fromAccountId, toAccountId) as userId,
      SUM(if(toAccountType = '${bankAccountType}', amount, -amount)) as amount,
      SUM(if(toAccountType = '${bankAccountType}', 0, bt.amount)) as extracted
    FROM buzzTransactions bt
    WHERE (
      -- Banks
      toAccountType = '${bankAccountType}'
      AND toAccountId = ${monthAccount}
      AND fromAccountType IN (${buzzBankTypesSql})
    ) OR (
      -- Extracts
      fromAccountType = '${bankAccountType}'
      AND fromAccountId = ${monthAccount}
      AND toAccountType IN (${buzzBankTypesSql})
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

export async function getPoolParticipantsV2(month?: Date, includeNegativeAmounts = false) {
  month ??= new Date();
  const monthAccount = getMonthAccount(month);
  const data = await getTopContributors({
    accountIds: [monthAccount],
    accountType: 'creatorProgramBank',
    limit: 10000,
    all: true,
  });
  // A creator who banked from more than one source account type (e.g. green + yellow) is returned
  // as one contributor row per source type. Sum them per userId so each creator is a single
  // participant and receives a single compensation grant — otherwise the distribute loop emits two
  // grants sharing one externalTransactionId and the second is silently dropped as a conflict,
  // paying the creator for only one buzz type. A Map preserves the upstream contributor order that
  // the distribute loop's pool-depletion cutoff depends on (Object.values would reorder by userId).
  const summed = new Map<number, { userId: number; amount: number }>();
  for (const p of data[`${monthAccount}`] ?? []) {
    const existing = summed.get(p.userId);
    if (existing) existing.amount += p.amount;
    else summed.set(p.userId, { userId: p.userId, amount: p.amount });
  }
  const participants = [...summed.values()];
  let bannedParticipants: { userId: number }[] = [];

  if (participants.length > 0) {
    bannedParticipants = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT "id" as "userId"
      FROM "User"
      WHERE id IN (${Prisma.join(participants.map((p) => p.userId))})
        AND ("bannedAt" IS NOT NULL OR onboarding & ${OnboardingSteps.BannedCreatorProgram} != 0);
    `;
  }

  return participants
    .filter((p) => !bannedParticipants.some((b) => b.userId === p.userId))
    .filter((p) => includeNegativeAmounts || p.amount > 0);
}

const REFUNDED_WITHDRAWAL_STATUSES: CashWithdrawalStatus[] = [
  CashWithdrawalStatus.Rejected,
  CashWithdrawalStatus.Canceled,
];

/**
 * Whether the burn behind a withdrawal has already been refunded: a refund this path recorded on
 * the row (it always stores metadata.refundTransactionId, under either key it has used), or one on
 * the Buzz ledger under `refund-<transactionId>`, which is how withdrawCash's failure path refunds.
 * The old bare `<transactionId>` key is deliberately not looked up on the ledger: that route may
 * also resolve the burn itself by its id, which would read every burn as refunded.
 */
async function isWithdrawalBurnRefunded(
  transactionId: string,
  metadata: CashWithdrawalMetadataSchema
) {
  if (metadata.refundTransactionId) return true;
  return !!(await getTransactionByExternalId(refundExternalTransactionId(transactionId)));
}

// A claim older than this belongs to a caller that died mid-refund. Taking it over is safe because
// the refund's external id is the same for every caller, and Buzz refuses a duplicate.
const REFUND_CLAIM_TTL = '15 minutes';

/** Takes the right to refund this withdrawal; only one caller at a time gets it. */
async function claimWithdrawalRefund(withdrawalId: string) {
  const claimed = await dbWrite.$executeRaw`
    UPDATE "CashWithdrawal"
    SET metadata = metadata || jsonb_build_object('refundClaimedAt', now())
    WHERE id = ${withdrawalId}
      AND (
        (metadata->>'refundClaimedAt') IS NULL
        OR (metadata->>'refundClaimedAt')::timestamptz < now() - ${REFUND_CLAIM_TTL}::interval
      );
  `;
  return claimed > 0;
}

async function releaseWithdrawalRefundClaim(withdrawalId: string) {
  await dbWrite.$executeRaw`
    UPDATE "CashWithdrawal" SET metadata = metadata - 'refundClaimedAt' WHERE id = ${withdrawalId};
  `;
}

export const updateCashWithdrawal = async ({
  withdrawalId,
  status,
  note,
  metadata: updatedMetadata,
  fees,
}: UpdateCashWithdrawalSchema) => {
  const withdrawal = await dbWrite.cashWithdrawal.findUniqueOrThrow({
    where: { id: withdrawalId },
  });

  const userId = withdrawal.userId;

  // Refund state comes from the stored row only: a caller's refundTransactionId would otherwise
  // skip the refund.
  const storedMetadata = (withdrawal.metadata ?? {}) as CashWithdrawalMetadataSchema;
  const { refundTransactionId: _callerRefund, ...callerMetadata } = (updatedMetadata ??
    {}) as CashWithdrawalMetadataSchema;
  // No claim is carried forward, the caller's or the stored one: writing back a claim its holder
  // has since released would block every later refund until the claim expires.
  const { refundClaimedAt: _storedClaim, ...metadata }: CashWithdrawalMetadataSchema = {
    ...storedMetadata,
    ...callerMetadata,
  };

  if (REFUNDED_WITHDRAWAL_STATUSES.includes(status) && withdrawal.transactionId) {
    const transactionId = withdrawal.transactionId;
    if (!(await isWithdrawalBurnRefunded(transactionId, storedMetadata))) {
      // Another caller is refunding it now. Refuse rather than record a terminal status with no
      // refund behind it: a retry either finds the refund or takes over a claim left by a crash.
      if (!(await claimWithdrawalRefund(withdrawalId)))
        throw new Error(
          `Refund for withdrawal ${withdrawalId} is already in progress; retry later`
        );

      try {
        await withRetries(async () => {
          const transaction = await createBuzzTransaction({
            type: TransactionType.Refund,
            toAccountType: 'cashSettled',
            toAccountId: userId,
            fromAccountId: 0, // central bank
            amount: withdrawal.amount - (fees ?? 0),
            description: `Refund for failed withdrawal. Fees: ${fees ?? 0}`,
            // The id Buzz's refund endpoint records, which withdrawCash's failure path uses: a
            // second refund of the same burn is a duplicate to Buzz as well.
            externalTransactionId: refundExternalTransactionId(transactionId),
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
      } catch (e) {
        await releaseWithdrawalRefundClaim(withdrawalId);
        throw e;
      }
    }
  }

  // No claw-back: the user keeps both, and this is how someone finds out.
  if (
    status === CashWithdrawalStatus.Paid &&
    withdrawal.transactionId &&
    (await isWithdrawalBurnRefunded(withdrawal.transactionId, storedMetadata).catch(() => false))
  )
    await logToAxiom({
      name: 'cash-withdrawal-paid-after-refund',
      type: 'error',
      withdrawalId,
      userId,
      previousStatus: withdrawal.status,
    }).catch(() => null);

  try {
    // Merged in SQL so a refund claim another caller stored meanwhile is not overwritten.
    await dbWrite.$executeRaw`
      UPDATE "CashWithdrawal"
      SET status = ${status}::"CashWithdrawalStatus", note = COALESCE(${note ?? null}, note),
        "updatedAt" = now(),
        metadata = metadata || ${JSON.stringify(metadata)}::jsonb
      WHERE id = ${withdrawalId};
    `;

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

      const totalBankedBuzz = cashedOutCreators.reduce((acc, p) => acc + p.amount, 0);
      const hasCashedOut = cashedOutCreators.length > 0;

      const data = {
        dollarValue: compensationPool.value,
        creatorCount: participants.length,
        totalBankedBuzz,
        extractedCreatorCount: extractedCreators.length,
        cashedOutCreatorCount: cashedOutCreators.length,
        totalExtractedBuzz: extractedCreators.reduce((acc, p) => acc + p.extracted, 0),
        dollarAmountPerThousand: formatToLeastDecimals(getCurrentValue(1000, compensationPool)),
        dollarHighestEarned: hasCashedOut
          ? formatToLeastDecimals(getCurrentValue(cashedOutCreators[0].amount, compensationPool))
          : 0,
        dollarAverageEarned: hasCashedOut
          ? formatToLeastDecimals(
              getCurrentValue(totalBankedBuzz / cashedOutCreators.length, compensationPool)
            )
          : 0,
        dollarMedianEarned: hasCashedOut
          ? formatToLeastDecimals(
              getCurrentValue(cashedOutCreators[median].amount, compensationPool)
            )
          : 0,
      };

      return data;
    },
    {
      ttl: CacheTTL.month,
    }
  );

  return data;
};

export async function modAdjustCashBalance({
  userId,
  amount,
  accountType,
  direction,
  note,
  modUserId,
}: ModCashAdjustmentInput & { modUserId: number }) {
  const externalId = `mod-cash-${modUserId}-${userId}-${Date.now()}`;

  if (direction === 'grant') {
    await createBuzzTransaction({
      amount,
      fromAccountId: 0,
      toAccountId: userId,
      toAccountType: accountType,
      type: TransactionType.Incentive,
      description: `Mod cash adjustment (grant): ${note}`,
      externalTransactionId: externalId,
    });
  } else {
    const { transactionId } = await createBuzzTransaction({
      amount,
      fromAccountId: userId,
      fromAccountType: accountType,
      toAccountId: 0,
      toAccountType: 'yellow',
      type: TransactionType.Withdrawal,
      description: `Mod cash adjustment (deduct): ${note}`,
      externalTransactionId: externalId,
    });

    if (!transactionId) {
      throw new Error('Failed to create transaction');
    }

    if (accountType === 'cashSettled') {
      await dbWrite.cashWithdrawal.create({
        data: {
          userId,
          amount,
          fee: 0,
          status: CashWithdrawalStatus.Reclaimed,
          method: CashWithdrawalMethod.Custom,
          transactionId,
          note: `[Mod adjustment] ${note}`,
          metadata: { modUserId, accountType, direction },
        },
      });
    }
  }

  await logToAxiom({
    name: 'mod-cash-adjustment',
    type: 'info',
    modUserId,
    targetUserId: userId,
    amount,
    accountType,
    direction,
    note,
  });

  await userCashCache.bust(userId);

  signalClient.topicSend({
    topic: SignalTopic.CreatorProgram,
    target: SignalMessages.CashInvalidator,
    data: {},
  });
}
