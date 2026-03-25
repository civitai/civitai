import { getMultipliersForUser } from '~/server/services/buzz.service';
import { getUserCapCache } from '~/server/services/creator-program.service';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { refreshSession } from '~/server/auth/session-invalidation';
import type { SubscriptionMetadata, PrepaidToken } from '~/server/schema/subscriptions.schema';

// Buzz amounts per tier per month
const TIER_BUZZ_AMOUNTS: Record<string, number> = {
  bronze: 10000,
  silver: 25000,
  gold: 50000,
};

/**
 * Extracts prepaid tokens from subscription metadata.
 * If the new `tokens` array exists, returns it directly.
 * Otherwise, synthesizes locked tokens from legacy `prepaids` counters.
 * We do NOT synthesize claimed tokens from buzzTransactionIds — those were auto-delivered
 * and users had no control over them, so there's no point showing history for those.
 */
export function getPrepaidTokens({
  metadata,
}: {
  metadata: SubscriptionMetadata | null | undefined;
}): PrepaidToken[] {
  if (!metadata) return [];

  // New format — use directly
  if (metadata.tokens && metadata.tokens.length > 0) {
    return metadata.tokens;
  }

  // Legacy format — convert prepaids counters to locked tokens
  const prepaids = metadata.prepaids;
  if (!prepaids) return [];

  const tokens: PrepaidToken[] = [];
  const tiers = ['gold', 'silver', 'bronze'] as const;

  for (const tier of tiers) {
    const count = prepaids[tier] ?? 0;
    if (count <= 0) continue;

    const buzzAmount = TIER_BUZZ_AMOUNTS[tier] ?? 25000;

    for (let i = 0; i < count; i++) {
      tokens.push({
        id: `legacy_${tier}_${i}`,
        tier,
        status: 'locked',
        buzzAmount,
      });
    }
  }

  return tokens;
}

/**
 * Computes the next token unlock date based on the subscription's currentPeriodStart
 * day-of-month. Handles month-end edge cases (e.g., Jan 31 → Feb 28 → Mar 31).
 */
export function getNextTokenUnlockDate(currentPeriodStart: Date | string): Date {
  const periodStart = new Date(currentPeriodStart);
  const targetDay = periodStart.getDate();
  const now = new Date();

  let baseMonth = now.getMonth();
  let baseYear = now.getFullYear();

  // Check if this month's delivery day has already passed
  const thisMonthLastDay = new Date(baseYear, baseMonth + 1, 0).getDate();
  const thisMonthDeliveryDay = Math.min(targetDay, thisMonthLastDay);
  const thisMonthDelivery = new Date(baseYear, baseMonth, thisMonthDeliveryDay);
  if (thisMonthDelivery <= now) {
    baseMonth += 1;
  }

  const year = baseYear + Math.floor(baseMonth / 12);
  const normalizedMonth = ((baseMonth % 12) + 12) % 12;
  const lastDayOfMonth = new Date(year, normalizedMonth + 1, 0).getDate();
  const day = Math.min(targetDay, lastDayOfMonth);

  return new Date(year, normalizedMonth, day);
}

export const invalidateSubscriptionCaches = async (userId: number) => {
  await Promise.allSettled([
    refreshSession(userId),
    getMultipliersForUser(userId, true),
    setVaultFromSubscription({
      userId,
    }),
    getUserCapCache('yellow').bust(userId),
    getUserCapCache('green').bust(userId),
    invalidateCivitaiUser({ userId }),
  ]);
};
