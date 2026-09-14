import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import { MOD_ACTION_REASON_PREFIX, type SharedReportReader, type SharedReportRow } from './reader';
import { buildReports, confidenceFor, renderSummary, toFinding, type ReportedRow } from './report';

/**
 * 🔴 THE LOOKBACK WINDOW AND THE CRON CADENCE ARE ONE NUMBER IN TWO PLACES.
 *
 * This run does NOT dedupe against earlier runs — there is no "reported to the board" column on
 * `shared_kv_reports` and adding one would be a write, which this job deliberately cannot do. So the
 * window has to tile the timeline exactly:
 *
 *   - window SHORTER than the cadence ⇒ a gap, and a user's abuse report is silently never surfaced,
 *     which is precisely the hole this job exists to close;
 *   - window LONGER than the cadence ⇒ every report is filed again on every run, and the board fills
 *     with duplicates of one cohort until it is useless to a moderator.
 *
 * 24 hours here, `0 7 * * *` in `~/server/jobs/shared-storage-report-sweep.ts`. CHANGE ONE AND YOU
 * MUST CHANGE THE OTHER — or add cross-run dedupe first. `job-wiring.test.ts` pins the pair.
 */
export const SHARED_REPORT_WINDOW_HOURS = 24;

/**
 * How many report rows one run will read.
 *
 * Generous on purpose: reports are per-(reporter, row) deduped at the write site and rate-limited
 * per (user, app) per day, so a day's honest volume is nowhere near this. The budget exists so a
 * pathological day cannot turn one run into an unbounded scan — and when it IS hit, the run says so
 * in its summary and its counters rather than quietly reporting a subset as the whole.
 */
export const MAX_REPORT_ROWS_SCANNED = 5 * MAX_FINDINGS_PER_REPORT;

export type SharedStorageReportSweepDeps = {
  /**
   * 🔴 NULLABLE BECAUSE THE REAL READER IS. `APPS_DATABASE_URL` is unset on PR previews, dev and the
   * legacy stage cluster, and the App Blocks datastore is this sweep's only source. That is a
   * supported state: the run reports it and files nothing, rather than filing an empty run that a
   * moderator would read as "nobody reported anything today".
   */
  reader: SharedReportReader | null;
  /** In production `moderatorApp.abuseReport`, which validates against the shared contract before the
   *  network call and cannot do anything else. */
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  /** The producer's clock. Injected because the board's "how current is this" reading depends on
   *  `startedAt`/`finishedAt` being the producer's own times, not receipt time. */
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export type SharedStorageReportSweepResult = {
  scanned: number;
  /** Rows that survived the moderator-audit-row filter — the actual user reports. */
  userReports: number;
  /** `apps.mod.purgeSharedRow` audit rows discarded. Counted so "the board is quiet" stays legible. */
  modActionRowsSkipped: number;
  rowsReported: number;
  unattributed: number;
  appsScanned: number;
  appsFailed: number;
  truncated: boolean;
  reports: number;
  skipped?: 'apps-db-unavailable';
};

/**
 * Fold one window's `shared_kv_reports` rows into ONE abuse-board run.
 *
 * 🔴 ONE RUN PER WINDOW, NOT ONE RUN PER REPORT. The board is run-shaped
 * (`startedAt`/`finishedAt`/`findings[]`) and its index page lists runs, so posting a run per user
 * report would push every other detector off the page after a handful of reports.
 *
 * 🔴 AND ONE FINDING PER REPORTED ROW, NOT PER REPORT. Five users flagging one row is one moderator
 * decision, and it is a STRONGER one — so the reports collapse into a single finding whose reporter
 * count is what raises its confidence, i.e. its position in the queue.
 */
export async function runSharedStorageReportSweep(
  deps: SharedStorageReportSweepDeps
): Promise<SharedStorageReportSweepResult> {
  const startedAt = deps.now();

  if (!deps.reader) {
    deps.log?.('shared-storage-report-sweep-skipped', { reason: 'apps-db-unavailable' });
    return {
      scanned: 0,
      rowsReported: 0,
      unattributed: 0,
      appsScanned: 0,
      appsFailed: 0,
      truncated: false,
      reports: 0,
      userReports: 0,
      modActionRowsSkipped: 0,
      skipped: 'apps-db-unavailable',
    };
  }

  const since = new Date(startedAt.getTime() - SHARED_REPORT_WINDOW_HOURS * 60 * 60 * 1000);
  const scan = await deps.reader.listUserReports({
    since,
    until: startedAt,
    limit: MAX_REPORT_ROWS_SCANNED,
  });

  // 🔴 DROP THE MODERATOR'S OWN AUDIT ROWS BEFORE GROUPING. `apps.mod.purgeSharedRow` files a
  // `shared_kv_reports` row for every action a moderator takes, with the same two columns set as a
  // real user report — so without this the board would fill with entries recording that a moderator
  // had already dealt with something, attributed to that moderator as the "reporter".
  //
  // 🔴 BOTH HALVES ARE REQUIRED AND NEITHER IS SUFFICIENT. The `mod:` prefix alone is a guard on a
  // USER-SUPPLIED STRING — the reason on a real report is the reporter's own free text, so anyone
  // could type `mod:purge` and delete their own report from the only surface that would have shown
  // it. Requiring the reporter to BE a moderator is the half no ordinary account can satisfy.
  // Conversely the moderator half alone would swallow a moderator's own genuine user report, which
  // carries an ordinary reason and must reach the board like anyone else's.
  const candidates = scan.rows.filter((r) => r.reason?.startsWith(MOD_ACTION_REASON_PREFIX));
  const moderatorIds = await deps.reader.listModeratorIds(candidates.map((r) => r.reporterUserId));
  const userReportRows = scan.rows.filter(
    (r) => !(r.reason?.startsWith(MOD_ACTION_REASON_PREFIX) && moderatorIds.has(r.reporterUserId))
  );
  const modActionRows = scan.rows.length - userReportRows.length;

  const { rows, unattributed } = groupReports(userReportRows);

  // Strongest evidence first, matching the order the board renders findings in — so a run split
  // across batches puts the most-reported rows in the first one.
  rows.sort((a, b) => confidenceFor(b) - confidenceFor(a));

  const counters: Record<string, number> = {
    reports_scanned: scan.rows.length,
    user_reports: userReportRows.length,
    mod_action_rows_skipped: modActionRows,
    rows_reported: rows.length,
    unattributed_reports: unattributed,
    apps_scanned: scan.appsScanned,
    apps_failed: scan.appsFailed,
    window_hours: SHARED_REPORT_WINDOW_HOURS,
    scan_truncated: scan.truncated ? 1 : 0,
  };

  const reports = buildReports({
    findings: rows.map(toFinding),
    startedAt,
    finishedAt: deps.now(),
    summary: renderSummary({
      rows,
      reports: userReportRows.length - unattributed,
      unattributed,
      windowHours: SHARED_REPORT_WINDOW_HOURS,
      apps: scan.appsScanned,
      truncated: scan.truncated,
    }),
    counters,
  });

  // Filed even with no findings: a run row with zero findings is how the board says "this sweep ran
  // and there was nothing to surface", which is a different and necessary claim from the sweep having
  // gone quiet. `counters` carries the population it looked at either way.
  for (const report of reports) await deps.sendReport(report);

  deps.log?.('shared-storage-report-sweep-reported', {
    ...counters,
    reports: reports.length,
  });

  return {
    scanned: scan.rows.length,
    userReports: userReportRows.length,
    modActionRowsSkipped: modActionRows,
    rowsReported: rows.length,
    unattributed,
    appsScanned: scan.appsScanned,
    appsFailed: scan.appsFailed,
    truncated: scan.truncated,
    reports: reports.length,
  };
}

/**
 * Collapse raw report rows into one `ReportedRow` per (app, reported key).
 *
 * 🔴 A REPORT WHOSE ROW IS GONE HAS NO SUBJECT, SO IT CANNOT BECOME A FINDING. `finding.userId` is
 * the account the finding is ABOUT, and when the reported `shared_kv` row has been purged there is no
 * author left to name. Falling back to the REPORTER would be worse than dropping it — it would file
 * the person who flagged the abuse as the subject of a moderator queue entry. So these are counted,
 * named in the summary, and not listed. In practice a purged row is one a moderator already acted on.
 *
 * 🔴 NOTHING IN THE OUTPUT OF THIS FUNCTION CAN CARRY THE REPORTED CONTENT. Its input type has no
 * field for it and neither does its output; see `reader.ts` for the query that never selects it.
 */
export function groupReports(reportRows: SharedReportRow[]): {
  rows: ReportedRow[];
  unattributed: number;
} {
  const byKey = new Map<string, ReportedRow>();
  let unattributed = 0;

  for (const row of reportRows) {
    if (row.authorUserId == null || row.authorUserId <= 0) {
      unattributed += 1;
      continue;
    }
    // `\u0000` written as an ESCAPE, never as a literal byte: a raw NUL in source is invisible
    // in an editor, makes the file binary to git and grep, and reads as an ordinary space.
    // It is the separator rather than a space because a shared_kv key is arbitrary text up to
    // 64 chars while a slug matches `^[a-z][a-z0-9_]{2,40}$`, so only a character the slug
    // alphabet cannot contain makes the pair unambiguous.
    const groupKey = `${row.slug}\u0000${row.key}`;
    const existing = byKey.get(groupKey);
    if (!existing) {
      byKey.set(groupKey, {
        slug: row.slug,
        appBlockId: row.appBlockId,
        key: row.key,
        authorUserId: row.authorUserId,
        hidden: row.hidden,
        reporterUserIds: [row.reporterUserId],
        reasons: row.reason == null ? [] : [row.reason],
        firstReportedAt: row.createdAt,
        lastReportedAt: row.createdAt,
      });
      continue;
    }
    // Distinct reporters only: the write site dedupes per (reporter, key), but READ COMMITTED can
    // admit a true double-submit, and a duplicate reporter must not inflate the confidence that
    // decides this row's place in the queue.
    if (!existing.reporterUserIds.includes(row.reporterUserId))
      existing.reporterUserIds.push(row.reporterUserId);
    if (row.reason != null) existing.reasons.push(row.reason);
    existing.hidden = existing.hidden || row.hidden;
    if (row.createdAt < existing.firstReportedAt) existing.firstReportedAt = row.createdAt;
    if (row.createdAt > existing.lastReportedAt) existing.lastReportedAt = row.createdAt;
  }

  return { rows: [...byKey.values()], unattributed };
}
