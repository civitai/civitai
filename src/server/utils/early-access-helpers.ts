import { constants } from '~/server/common/constants';
import type { UserMeta } from '~/server/schema/user.schema';
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

export function getMaxEarlyAccessDays({ userMeta }: { userMeta?: UserMeta }) {
  const earlyAccessUnlockedDays = constants.earlyAccess.scoreTimeFrameUnlock
    .map(([score, days]) => ((userMeta?.scores?.models ?? 0) >= score ? days : null))
    .filter(isDefined);

  return earlyAccessUnlockedDays.length > 0
    ? earlyAccessUnlockedDays[earlyAccessUnlockedDays.length - 1]
    : 0;
}

export function getMaxEarlyAccessModels({ userMeta }: { userMeta?: UserMeta }) {
  const earlyAccessUnlockedDays = constants.earlyAccess.scoreQuantityUnlock
    .map(([score, days]) => ((userMeta?.scores?.models ?? 0) >= score ? days : null))
    .filter(isDefined);

  return earlyAccessUnlockedDays.length > 0
    ? earlyAccessUnlockedDays[earlyAccessUnlockedDays.length - 1]
    : 0;
}
