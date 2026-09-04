import { logToAxiom } from '~/server/logging/client';
import { createCohortReader } from '~/server/services/bot-account-detection/cohort';
import { createEvidenceReader } from '~/server/services/bot-account-detection/evidence';
import { runBotAccountDetection } from '~/server/services/bot-account-detection/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

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
 * 🔴 REGISTERED BUT NOT SCHEDULED — `UNRUNNABLE_JOB_CRON` is a deliberate choice, not a leftover.
 * `/api/internal/get-jobs` publishes every registered job's cron to the external scheduler, so a
 * real cron here means MERGING THIS ENABLES IT: at 03:20 UTC the next day it would POST to a board
 * whose table may not have been applied yet (`apps/moderator/abuse-detection/schema.sql` is applied
 * by hand per this repo's convention — without its `(detector, started_at)` unique index every POST
 * 500s on a `42P10`), with a `MOD_INBOUND_TOKEN` that may be unset. That is a daily 500 repeating
 * until somebody notices, and the noticing is the only part that is not automatic.
 *
 * `UNRUNNABLE_JOB_CRON` (a Feb 31st that never comes) keeps the job REGISTERED and on-demand
 * runnable at `/api/webhooks/run-jobs/bot-account-detection` — which is the whole of what a
 * shadow-phase grading pass needs — while firing no schedule. Restoring a real cron is a one-token
 * change once both preconditions are confirmed live; the PR body records what they are.
 *
 * 🔴 `lockExpiration` IS THE MITIGATION FOR THE DUPLICATE RUN, and it is the only one. The run-jobs
 * route hard-caps the lock hold at exactly this value and then RELEASES the lock while the run
 * continues, so past that point a retry can start a second, concurrent full run whose different
 * `startedAt` the board's `(detector, started_at)` key cannot merge with the first — two complete
 * duplicate finding sets. Widening the window until a run fits inside it is what prevents that; the
 * `checkCanceled` wiring below does NOT, because `release()` clears the redis key and its refresh
 * interval and never touches the job context (see `acquireLock` in the route). A capped walk is up
 * to `MAX_COHORT_ACCOUNTS / COHORT_PAGE_SIZE` account pages plus eight `groupBy` reads each;
 * 30 minutes is comfortably above that and is a ceiling, not a reservation.
 */
export const botAccountDetection = createJob(
  'bot-account-detection',
  UNRUNNABLE_JOB_CRON,
  async (ctx) => {
    return runBotAccountDetection({
      reader: createCohortReader(),
      // The cohort-level sources. Its ClickHouse half is `undefined` on any deployment without
      // `CLICKHOUSE_HOST`, which is a supported state and NOT an error: the run reports
      // `evidence_registration_ips: 0` and says so in the summary rather than reporting that no
      // accounts shared an IP.
      evidence: createEvidenceReader(),
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      // The scheduler cancels by closing the response; without this the walk keeps paging and
      // keeps POSTing after nobody is listening.
      checkCanceled: () => ctx.checkIfCanceled(),
      log: (name, data) =>
        void logToAxiom({ type: 'info', name, ...data }, 'moderation').catch(() => undefined),
    });
  },
  { lockExpiration: 30 * 60 }
);
