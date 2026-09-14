import { logToAxiom } from '~/server/logging/client';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createSharedReportReader } from '~/server/services/shared-storage-report-sweep/reader';
import { runSharedStorageReportSweep } from '~/server/services/shared-storage-report-sweep/run';
import { createJob } from './job';

/**
 * App Blocks shared-storage USER-REPORT sweep.
 *
 * 🔴 WHY THIS EXISTS. A user reporting a shared-storage row filed a `shared_kv_reports` row that
 * NOTHING READ. Ordinary abuse — harassment, brigading, spam that dodged the automated content
 * audit — was therefore invisible to moderators, and a fire-and-forget Discord webhook was bolted
 * onto the report path as its only reader. A webhook post is not a queue: it cannot be triaged,
 * ranked, assigned or ruled on, and it is gone as soon as it scrolls. This job replaces it with the
 * surface that already does all of that — the moderator abuse-detection board at `/abuse`, the same
 * one `bot-account-detection` and `reaction-withdrawal-detection` write to.
 *
 * 🔴 THIS JOB IS NOW THE ONLY READER OF THOSE ROWS. Removing it without a replacement re-opens the
 * exact hole the webhook was added to cover.
 *
 * 🔴 THE CADENCE IS PINNED TO THE LOOKBACK WINDOW. `SHARED_REPORT_WINDOW_HOURS` is 24 and the run
 * does NOT dedupe against earlier runs, so the two must tile the timeline exactly: a shorter window
 * drops reports on the floor, a longer one re-files every report on every run until the board is
 * duplicates. Daily makes cadence and window equal. Change one and you must change the other.
 *
 * Why daily and not faster: a user report is a HUMAN-latency signal, not a live incident — the
 * reported row stays visible either way until a moderator hides it, so the thing an hourly cadence
 * would buy is a shorter queue latency, paid for with 24× the run rows on a board whose index page
 * lists runs. The auto-content-audit path already blocks the fast-moving class synchronously at
 * write time; this one is the residue that needs a human to look. Daily is also what both sibling
 * detectors settled on, so the board's run list stays readable.
 *
 * 07:00 UTC: clear of `bot-account-detection` at 12:00, `reaction-withdrawal-detection` at Monday
 * 09:00, and the two sibling detectors that write this same board on the 11:00 and 11:30 hours.
 *
 * 🔴 The cron string IS the deployment. `/api/internal/get-jobs` publishes it to the external
 * scheduler, which registers the trigger — adding this to the `jobs` array in the run-jobs route
 * with a real cron is the scheduling, and nothing else in this repo reads `Job.cron`.
 *
 * 🔴 NOTHING HERE ACTS. This file supplies a read-only reader port, the moderator client, and a
 * clock. The run holds no write client, files `actioned: false` as a literal, and never hides a row,
 * bans an author or resolves a report — a moderator does that through `apps.mod.purgeSharedRow`.
 *
 * `lockExpiration` is the mitigation for a duplicate run: the run-jobs route hard-caps the lock hold
 * at this value and then releases while the run continues, so a retry past it can start a second
 * concurrent run whose different `startedAt` the board's `(detector, started_at)` key cannot merge
 * with the first. A bounded scan over a handful of app schemas is a couple of seconds of work; ten
 * minutes is orders of magnitude of headroom, which is the point.
 */
export const sharedStorageReportSweep = createJob(
  'shared-storage-report-sweep',
  '0 7 * * *',
  async () => {
    return runSharedStorageReportSweep({
      reader: createSharedReportReader(),
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom({ type: 'info', name, ...data }, 'moderation').catch(() => undefined),
    });
  },
  { lockExpiration: 10 * 60 }
);
