// Who on a report earns nothing when it is actioned, read by both apps' payouts: the main app's
// `bulkSetReportStatus` and the moderator app's `setReportStatus`. One copy, so the two cannot disagree.

/**
 * Set on `Report.details` for the filer, and inside an `additionalReports` entry's `details` for a
 * reporter folded in later. The main app's `createReport` writes it on every report, overwriting
 * whatever the client sent, so a value read back here was put there by the server.
 */
export const NO_REPORT_REWARD_KEY = 'noReportReward';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The filer and folded-in reporters this report's details mark as earning no reward for it. */
export function reportersWithoutReward(report: { userId: number; details: unknown }): number[] {
  const details = isRecord(report.details) ? report.details : {};
  const ids = details[NO_REPORT_REWARD_KEY] === true ? [report.userId] : [];
  const additional = Array.isArray(details.additionalReports) ? details.additionalReports : [];
  for (const entry of additional) {
    if (!isRecord(entry) || typeof entry.userId !== 'number') continue;
    if (isRecord(entry.details) && entry.details[NO_REPORT_REWARD_KEY] === true)
      ids.push(entry.userId);
  }
  return ids;
}
