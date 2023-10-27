import { increaseDate, maxDate } from '~/utils/date-helpers';

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
