import type { PrepaidToken, SubscriptionMetadata } from '~/server/schema/subscriptions.schema';

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
 *
 * This does NOT include historical claimed tokens — those are fetched on-demand
 * from the buzz service via the PrepaidBuzzHistory component.
 *
 * This function is safe to use on both client and server.
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

// Cron fires at 01:00 UTC; add 15 min buffer so users don't feel "late"
// if the job takes a few minutes to process their subscription.
const UNLOCK_HOUR_UTC = 1;
const UNLOCK_BUFFER_MINUTES = 15;

/**
 * Returns the instant of the next prepaid token drop.
 *
 * Drops fire at 01:00 UTC (see `unlockPrepaidTokens` cron in
 * `src/server/jobs/prepaid-membership-jobs.ts`) on the day-of-month matching
 * the subscription's `currentPeriodStart`. The DB column is
 * `timestamp without time zone`, so the server SQL `EXTRACT(day from ...)`
 * sees the bare stored day — we match that by reading `getUTCDate()` from the
 * Prisma-serialized ISO string, which reflects the same literal day.
 *
 * Clamps to the month's last day for month-end starts (e.g., Jan 31 → Feb 28).
 * Adds a 15-minute buffer past the cron trigger so users aren't shown a
 * "next unlock" time that's already passed while the job is still running.
 *
 * Returns a UTC instant; callers format it in the user's locale.
 * Safe on both client and server.
 */
export function getNextTokenUnlockDate(currentPeriodStart: Date | string): Date {
  const periodStart = new Date(currentPeriodStart);
  const targetDay = periodStart.getUTCDate();
  const now = new Date();

  const buildDrop = (year: number, month: number): Date => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(targetDay, lastDay);
    return new Date(Date.UTC(year, month, day, UNLOCK_HOUR_UTC, UNLOCK_BUFFER_MINUTES, 0));
  };

  const thisMonthDrop = buildDrop(now.getUTCFullYear(), now.getUTCMonth());
  if (thisMonthDrop > now) return thisMonthDrop;

  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  if (month > 11) {
    year += 1;
    month = 0;
  }
  return buildDrop(year, month);
}
