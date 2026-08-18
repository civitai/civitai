import type { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';
import { constants, EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import type { UserMeta } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { increaseDate, maxDate } from '~/utils/date-helpers';
import { isDefined } from '~/utils/type-guards';

// DEPRECATED: Use the `earlyAccessEndsAt` field on the model version instead
export function getEarlyAccessDeadline({
  versionCreatedAt,
  publishedAt,
  earlyAccessTimeframe,
}: {
  versionCreatedAt: Date;
  publishedAt: Date | null;
  earlyAccessTimeframe: number;
}) {
  if (earlyAccessTimeframe === 0) return undefined;
  const deadline = increaseDate(
    publishedAt ? maxDate(versionCreatedAt, publishedAt) : versionCreatedAt,
    earlyAccessTimeframe,
    'days'
  );

  return deadline;
}

// DEPRECATED: Use the `earlyAccessEndsAt` field on the model version instead
export function isEarlyAccess({
  versionCreatedAt,
  publishedAt,
  earlyAccessTimeframe,
}: {
  versionCreatedAt: Date;
  publishedAt: Date | null;
  earlyAccessTimeframe: number;
}) {
  const deadline = getEarlyAccessDeadline({ versionCreatedAt, publishedAt, earlyAccessTimeframe });
  if (!deadline) return false;
  return new Date() < deadline;
}

export function getMaxEarlyAccessDays({
  userMeta,
  features,
}: {
  userMeta?: UserMeta;
  features?: FeatureAccess;
}) {
  const earlyAccessUnlockedDays = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock
    .map(([score, days]) => {
      if (typeof score === 'function') {
        return score({ features }) ? (days as number) : null;
      }

      return (userMeta?.scores?.models ?? 0) >= score ? (days as number) : null;
    })
    .filter(isDefined);

  return earlyAccessUnlockedDays.length > 0
    ? earlyAccessUnlockedDays[earlyAccessUnlockedDays.length - 1]
    : 0;
}

export function getMaxEarlyAccessModels({
  userMeta,
  features,
}: {
  userMeta?: UserMeta;
  features?: FeatureAccess;
}) {
  const earlyAccessUnlockedDays = EARLY_ACCESS_CONFIG.scoreQuantityUnlock
    .map(([score, days]) => {
      if (typeof score === 'function') {
        return score({ features }) ? (days as number) : null;
      }

      return (userMeta?.scores?.models ?? 0) >= score ? (days as number) : null;
    })
    .filter(isDefined);

  return earlyAccessUnlockedDays.length > 0
    ? earlyAccessUnlockedDays[earlyAccessUnlockedDays.length - 1]
    : 0;
}

/** How long after a version publishes its early access buyers still block an unpublish. */
export const EARLY_ACCESS_REFUND_WINDOW_MONTHS = 3;

/**
 * Deliberately UTC rather than `increaseDate`, which adds months in local time: three months spans a
 * DST change in most zones, so the same publish time yields a boundary an hour apart depending on
 * where the process runs. Short months clamp (Nov 30 lands on Feb 28), and the time of day is
 * carried through untouched so the boundary stays a timestamp.
 */
function earlyAccessRefundWindowEnd(publishedAt: Date) {
  const end = new Date(publishedAt.getTime());
  const dayOfMonth = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + EARLY_ACCESS_REFUND_WINDOW_MONTHS);
  const daysInEndMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)
  ).getUTCDate();
  end.setUTCDate(Math.min(dayOfMonth, daysInEndMonth));
  return end;
}

/**
 * Early access runs for at most 30 days (`EARLY_ACCESS_CONFIG.timeframeValues`), so a version this
 * far past publish has no early access left to take away and unpublishing owes its buyers nothing.
 *
 * A version with no `publishedAt` counts as inside the window: it has no clock to measure from, and
 * the refund obligation is the safe side of that.
 */
export function isWithinEarlyAccessRefundWindow(publishedAt: Date | null, now = new Date()) {
  if (!publishedAt) return true;
  return now < earlyAccessRefundWindowEnd(publishedAt);
}
