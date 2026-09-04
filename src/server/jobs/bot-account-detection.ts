import { logToAxiom } from '~/server/logging/client';
import { createCohortReader } from '~/server/services/bot-account-detection/cohort';
import { runBotAccountDetection } from '~/server/services/bot-account-detection/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

/**
 * Bot-account detection, SHADOW MODE.
 *
 * Reads the accounts registered in the last day that have already posted, scores each one, and files
 * the result on the moderator app's abuse-detection board with `actioned: false` on every finding.
 * It mutes nobody. See `~/server/services/bot-account-detection/report.ts` for why the board rather
 * than a `UserRestriction` row — briefly: `applyPendingReviewMute` has no file-without-mute path, so
 * filing a Pending row without muting would manufacture the one state that service says a Pending
 * row must never be left in.
 *
 * This file is the ONLY wiring: it supplies a read-replica reader, the moderator client, and a
 * clock. The run itself holds no write client and no restriction service, so there is no
 * configuration of this job that can act on an account — turning it live is a code change here and
 * in the run, not a flag.
 *
 * Scheduled off the hour so a daily full-window read does not land on top of the top-of-hour jobs.
 * The window is 24h and the schedule is daily, so a missed run
 * leaves a gap rather than double-counting; it is also runnable on demand at
 * `/api/webhooks/run-jobs/bot-account-detection`, which is how a shadow-phase grading pass gets a
 * fresh report without waiting for the schedule.
 */
export const botAccountDetection = createJob('bot-account-detection', '20 3 * * *', async () => {
  return runBotAccountDetection({
    reader: createCohortReader(),
    sendReport: (report) => moderatorApp.abuseReport(report),
    now: () => new Date(),
    log: (name, data) =>
      void logToAxiom({ type: 'info', name, ...data }, 'moderation').catch(() => undefined),
  });
});
