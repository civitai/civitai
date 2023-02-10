import { increaseDate, maxDate } from '~/utils/date-helpers';

export function getEarlyAccessDeadline({ versionCreatedAt, publishedAt, earlyAccessTimeframe }: { versionCreatedAt: Date, publishedAt: Date | null, earlyAccessTimeframe: number }) {
  const deadline = increaseDate(
    publishedAt ? maxDate(versionCreatedAt, publishedAt) : versionCreatedAt,
    earlyAccessTimeframe,
    'days'
  );

  return deadline;
}

export function isEarlyAccess({ versionCreatedAt, publishedAt, earlyAccessTimeframe }: { versionCreatedAt: Date, publishedAt: Date | null, earlyAccessTimeframe: number }) {
  const deadline = getEarlyAccessDeadline({ versionCreatedAt, publishedAt, earlyAccessTimeframe });
  return new Date() < deadline;
}