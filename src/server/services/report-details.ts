import type { Prisma } from '@prisma/client';

export const ADDITIONAL_REPORTS_KEY = 'additionalReports';

/**
 * A second report on the same (reason, entity) is folded into the first, which records the extra
 * reporter as an id in `alsoReportedBy` and nothing else — so their own words were dropped on the
 * floor. Real-person reports now REQUIRE a comment, so those reporters were being made to write one
 * that nothing would ever read.
 *
 * Returns undefined when the new report carries nothing beyond the `reportType` key `createReport`
 * stamps on every report, so a duplicate with no comment does not grow the row.
 */
export function withAdditionalReport(
  existing: Prisma.JsonValue,
  { userId, details, at }: { userId: number; details?: Record<string, unknown>; at?: Date }
) {
  const kept = Object.fromEntries(
    Object.entries(details ?? {}).filter(([key]) => key !== 'reportType')
  );
  if (!Object.keys(kept).length) return undefined;

  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const prior = Array.isArray(base[ADDITIONAL_REPORTS_KEY]) ? base[ADDITIONAL_REPORTS_KEY] : [];

  return {
    ...base,
    [ADDITIONAL_REPORTS_KEY]: [
      ...prior,
      { userId, createdAt: (at ?? new Date()).toISOString(), details: kept },
    ],
  } as Prisma.InputJsonValue;
}
