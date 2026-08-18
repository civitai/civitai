import type { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';
import dayjs from '~/shared/utils/dayjs';
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

/**
 * A buyer can be refunded for this long after they pay. Past it, unpublishing owes them nothing —
 * so a version nobody has bought in this long carries no refund obligation at all.
 */
export const PAID_ACCESS_REFUND_WINDOW_DAYS = 30;

/**
 * The instant a purchase made at `purchasedAt` stops being refundable.
 *
 * UTC rather than `increaseDate`, which adds CALENDAR days in local time: a window spanning a DST
 * change then runs 719 or 721 hours instead of 720, so the same purchase would fall in or out of
 * the window depending on the server's zone.
 */
export function paidAccessRefundWindowEnd(purchasedAt: Date) {
  return dayjs.utc(purchasedAt).add(PAID_ACCESS_REFUND_WINDOW_DAYS, 'day').toDate();
}

/** Whether unpublishing still owes this purchase a refund. */
export function isWithinPaidAccessRefundWindow(purchasedAt: Date | null, now = new Date()) {
  if (!purchasedAt) return true;
  return now < paidAccessRefundWindowEnd(purchasedAt);
}
