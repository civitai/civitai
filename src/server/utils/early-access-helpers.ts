import type { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';
import dayjs from '~/shared/utils/dayjs';
import { constants, EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import type { UserMeta } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { increaseDate, maxDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';

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

      return creatorScoreFromMeta(userMeta) >= score ? (days as number) : null;
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

      return creatorScoreFromMeta(userMeta) >= score ? (days as number) : null;
    })
    .filter(isDefined);

  return earlyAccessUnlockedDays.length > 0
    ? earlyAccessUnlockedDays[earlyAccessUnlockedDays.length - 1]
    : 0;
}

type EarlyAccessRungs = (typeof EARLY_ACCESS_CONFIG)['scoreTimeFrameUnlock'];

/** The score-thresholded rungs of an early-access ladder, without the feature-flag ones. */
export const scoreRungs = (rungs: EarlyAccessRungs) =>
  rungs.flatMap(([score, value]) => (typeof score === 'number' ? [[score, value] as const] : []));

const valueAtScore = (rungs: EarlyAccessRungs, score: number) => {
  const reached = scoreRungs(rungs).filter(([minScore]) => minScore <= score);
  return reached[reached.length - 1]?.[1] ?? 0;
};

/**
 * The lowest score at which early access opens on BOTH ladders, and what it grants there. The two entry
 * rungs are separate config that nothing keeps equal, so this takes the later of the two.
 */
export function getEarlyAccessEntryRung(
  config: Pick<
    typeof EARLY_ACCESS_CONFIG,
    'scoreTimeFrameUnlock' | 'scoreQuantityUnlock'
  > = EARLY_ACCESS_CONFIG
) {
  const [days, quantity] = [
    scoreRungs(config.scoreTimeFrameUnlock),
    scoreRungs(config.scoreQuantityUnlock),
  ];
  if (!days.length || !quantity.length) return null;
  const minScore = Math.max(days[0][0], quantity[0][0]);
  return {
    minScore,
    days: valueAtScore(config.scoreTimeFrameUnlock, minScore),
    versions: valueAtScore(config.scoreQuantityUnlock, minScore),
  };
}

export function chapterEarlyAccessLockedMessage(score: number | undefined) {
  const rung = getEarlyAccessEntryRung();
  const opens = rung
    ? `Early access for chapters unlocks at a Creator Score of ${numberWithCommas(rung.minScore)}.`
    : 'Early access for chapters is not available yet.';
  return score == null ? opens : `${opens} You're at ${numberWithCommas(Math.floor(score))}.`;
}

export function chapterEarlyAccessCapMessage({
  active,
  limit,
  score,
}: {
  active: number;
  limit: number;
  score: number | undefined;
}) {
  if (limit === 0) return chapterEarlyAccessLockedMessage(score);
  const chapters = `${active} ${active === 1 ? 'chapter' : 'chapters'}`;
  // A feature-flag rung can set the cap instead of the score, and then no score raises it.
  if (score == null || valueAtScore(EARLY_ACCESS_CONFIG.scoreQuantityUnlock, score) !== limit)
    return `You already have ${chapters} in early access, your current limit.`;

  const raisedLater = scoreRungs(EARLY_ACCESS_CONFIG.scoreQuantityUnlock).some(
    ([minScore]) => minScore > score
  );
  return [
    `You already have ${chapters} in early access, the most your Creator Score of ${numberWithCommas(
      Math.floor(score)
    )} allows.`,
    raisedLater && 'Higher scores raise it.',
  ]
    .filter(Boolean)
    .join(' ');
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
