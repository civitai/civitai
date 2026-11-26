import type { BuzzReadOptions } from '@civitai/buzz';
import { logToAxiom } from '~/server/logging/client';
import { userMultipliersCache } from '~/server/redis/caches';
import { clampRewardMultiplier } from '~/server/rewards/multiplier';
import type { CreateBuzzTransactionInput } from '~/server/schema/buzz.schema';
import { getBuzzTransactionResponse } from '~/server/schema/buzz.schema';
import { buzzService } from '~/server/services/buzz-client';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';

// Kept out of buzz.service: `~/server/rewards` imports this, and buzz.service reaches the rewards
// back through its own imports (docs/dev/import-cycles.md).

export function getMultipliersForUserCache(userIds: number[]) {
  return userMultipliersCache.fetch(userIds);
}

const MAX_GLOBAL_BONUS = 5;

/**
 * Returns the global rewards bonus multiplier from the active RewardsBonusEvent.
 * The event's `multiplier` column stores value * 10 (e.g. 20 = 2x, 5 = 0.5x).
 * Returns 1 when no event is active or the value is invalid.
 * Capped at MAX_GLOBAL_BONUS to prevent config mistakes from breaking the economy.
 */
export async function getGlobalRewardsBonusMultiplier(): Promise<number> {
  try {
    const { getActiveRewardsBonusEvent } = await import(
      '~/server/services/rewards-bonus-event.service'
    );
    const event = await getActiveRewardsBonusEvent();
    if (!event) return 1;

    const parsed = event.multiplier / 10;
    if (!Number.isFinite(parsed) || parsed < 1) return 1;

    return Math.min(parsed, MAX_GLOBAL_BONUS);
  } catch {
    return 1;
  }
}

export async function getMultipliersForUser(userId: number, refresh = false) {
  if (refresh) await deleteMultipliersForUserCache(userId);

  const multipliers = await getMultipliersForUserCache([userId]);
  const base = multipliers[userId] ?? {
    purchasesMultiplier: 1,
    rewardsMultiplier: 1,
    rewardsIneligible: false,
    userId,
  };

  const { getActiveRewardsBonusEvent } = await import(
    '~/server/services/rewards-bonus-event.service'
  );
  const event = await getActiveRewardsBonusEvent();

  const rawMultiplier = event ? event.multiplier / 10 : 1;
  const globalRewardsBonus = Number.isFinite(rawMultiplier)
    ? Math.min(Math.max(rawMultiplier, 1), MAX_GLOBAL_BONUS)
    : 1;

  // `globalRewardsBonus` is guarded above; `base.rewardsMultiplier` is read straight off
  // operator-authored `Product.metadata` and feeds the award computation and the Redis Lua cap
  // script, and `foldUserMultipliers` floors it only on a cache miss, so clamp here too.
  const baseRewardsMultiplier = clampRewardMultiplier(base.rewardsMultiplier);

  return {
    ...base,
    rewardsMultiplier: baseRewardsMultiplier * globalRewardsBonus,
    baseRewardsMultiplier,
    globalRewardsBonus,
    rewardsBonusEvent:
      event && globalRewardsBonus > 1
        ? {
            id: event.id,
            name: event.name,
            description: event.description,
            articleId: event.articleId,
            bannerLabel: event.bannerLabel,
            multiplier: event.multiplier,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
          }
        : null,
  };
}

export function deleteMultipliersForUserCache(userId: number) {
  return userMultipliersCache.refresh(userId);
}

export async function createBuzzTransactionMany(
  transactions: (CreateBuzzTransactionInput & {
    fromAccountId: number;
    externalTransactionId: string;
    fromAccountType?: BuzzAccountType;
  })[]
) {
  // Protect against transactions that are not valid. A transaction with from === to
  // breaks the entire request.
  const validTransactions = transactions.filter(
    (t) => t.toAccountId !== undefined && t.fromAccountId !== t.toAccountId && t.amount > 0
  );

  const result = await buzzService.createTransactions(validTransactions);

  // The batch endpoint only reports successes + conflicts. A `conflict` is the idempotency guard
  // (a duplicate externalTransactionId — the money already moved), so it's benign. But an
  // `insufficientFunds` (or any other non-success) result is dropped from BOTH arrays: the money did
  // NOT move and it is otherwise invisible. Reconcile the counts and surface any shortfall — we can't
  // name the exact failures because successes come back as opaque ids, not externalTransactionIds.
  const unaccounted =
    validTransactions.length - result.transactions.length - result.conflicts.length;
  if (unaccounted > 0) {
    logToAxiom({
      type: 'buzz-transaction-many-dropped',
      expected: validTransactions.length,
      succeeded: result.transactions.length,
      conflicted: result.conflicts.length,
      unaccounted,
      batch: validTransactions.slice(0, 500).map((t) => ({
        externalTransactionId: t.externalTransactionId,
        fromAccountId: t.fromAccountId,
        toAccountId: t.toAccountId,
        amount: t.amount,
      })),
    });
  }

  return result;
}

export async function getTransactionByExternalId(externalId: string, opts?: BuzzReadOptions) {
  const data = await buzzService.getTransactionByExternalId(externalId, opts);
  if (data === null) return null;
  return getBuzzTransactionResponse.parse(data);
}
