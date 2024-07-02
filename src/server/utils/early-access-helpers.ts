import { increaseDate, maxDate } from '~/utils/date-helpers';

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
