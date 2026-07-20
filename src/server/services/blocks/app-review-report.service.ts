import semver from 'semver';
import type { AppReviewAgentReport } from '@prisma/client';
import { dbRead } from '~/server/db/client';

// App Blocks — agentic mod code-review report (P0 read/lookup layer).
//
// DARK/INERT: these are plain service functions read by NOTHING in the running
// image — no tRPC router, no REST handler, no job calls them in P0. They exist so
// the later provisioning / UI / chat phases have a stable read seam. Applying the
// migration + shipping this file is therefore a no-op at runtime.

/**
 * Canonical agent-run lifecycle. Mirrored by the CHECK constraint in the
 * migration .sql (Prisma can't express a CHECK). `complete` is the only status
 * whose report is a valid "prior" link — a `running`/`failed`/`torn-down` report
 * is never used as the diff base.
 */
export const APP_REVIEW_AGENT_REPORT_STATUSES = [
  'running',
  'complete',
  'failed',
  'torn-down',
] as const;
export type AppReviewAgentReportStatus = (typeof APP_REVIEW_AGENT_REPORT_STATUSES)[number];

/**
 * The agent report for a given review (publish request), or null. If a review
 * was re-run and has more than one report, the most recently started one wins.
 */
export async function getAgentReport(
  publishRequestId: string
): Promise<AppReviewAgentReport | null> {
  if (!publishRequestId) return null;
  return dbRead.appReviewAgentReport.findFirst({
    where: { publishRequestId },
    orderBy: { startedAt: 'desc' },
  });
}

export type GetPriorAgentReportArgs = {
  appBlockId?: string | null;
  oauthClientId?: string | null;
  /** The version being reviewed now; the prior report must be strictly older. */
  version: string;
};

/**
 * The most recent `status='complete'` report for the SAME app (identified by
 * `appBlockId` XOR `oauthClientId`) whose version is strictly semver-OLDER than
 * `version` — i.e. the prior link in the chain the next review diffs against.
 * Returns null when the app has no earlier complete report.
 *
 * "Most recent" is resolved on the VERSION axis (the greatest version still
 * older than the target), which is the authoritative ordering for the chain;
 * ties (same version re-reviewed) break on `startedAt` desc. Only a handful of
 * versions exist per app, so the candidate set is fetched and compared in-app
 * (the `version` column is a lexical index — not semver-ordered — so the
 * ordering can't be pushed into SQL correctly).
 */
export async function getPriorAgentReport(
  args: GetPriorAgentReportArgs
): Promise<AppReviewAgentReport | null> {
  const { appBlockId, oauthClientId, version } = args;

  const hasBlock = appBlockId != null && appBlockId !== '';
  const hasClient = oauthClientId != null && oauthClientId !== '';
  if (hasBlock === hasClient) {
    // Enforce the "exactly one app key" invariant the column pair encodes.
    throw new Error(
      'getPriorAgentReport requires exactly one of { appBlockId, oauthClientId }'
    );
  }
  if (!semver.valid(version)) {
    throw new Error(`getPriorAgentReport: invalid semver version "${version}"`);
  }

  const where = hasBlock
    ? { appBlockId, status: 'complete' as const }
    : { oauthClientId, status: 'complete' as const };

  const candidates = await dbRead.appReviewAgentReport.findMany({ where });

  const prior = candidates
    // Only reports strictly older (by semver) than the version under review.
    .filter((r) => {
      const v = semver.valid(r.version);
      return v != null && semver.lt(v, version);
    })
    // Greatest version first; same-version re-reviews break on startedAt desc.
    .sort((a, b) => {
      const byVersion = semver.rcompare(a.version, b.version);
      if (byVersion !== 0) return byVersion;
      return b.startedAt.getTime() - a.startedAt.getTime();
    });

  return prior[0] ?? null;
}
