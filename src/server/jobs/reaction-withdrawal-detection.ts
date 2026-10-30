import { logToAxiom } from '~/server/logging/client';
import { defaultClickhouse } from '~/server/services/reaction-withdrawal-detection/detect';
import { runReactionWithdrawalDetection } from '~/server/services/reaction-withdrawal-detection/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

/**
 * Reaction-withdrawal detection, SHADOW MODE.
 *
 * Finds accounts that give a reaction and take it back within a minute, at volume, and files them on
 * the moderator app's abuse-detection board with `actioned: false` on every finding. It bans nobody:
 * the board's ingress is write-only, this file supplies no write client, and `actioned: false` is a
 * literal in `report.ts`.
 *
 * See `detect.ts` for the rule and the measurement behind it. Briefly: withdrawing a reaction deletes
 * the `ImageReaction` row, so this behaviour leaves no trace in Postgres and therefore none on any
 * moderator page — it can only be found across the population, in ClickHouse.
 *
 * 🔴 THE CADENCE IS PINNED TO THE LOOKBACK WINDOW. `WINDOW_DAYS` is 7 and the run does NOT dedupe
 * against earlier runs, so anything faster than weekly re-reports the same accounts every run and the
 * board fills with duplicates of one cohort. Weekly makes cadence and window equal. Change one and
 * you must change the other, or add dedupe first.
 *
 * Monday 09:00 UTC: clear of `bot-account-detection` at 12:00 and of the two sibling detectors that
 * write this same board on the 11:00 and 11:30 hours. 🔴 Those two run OUT OF THIS REPO as their own
 * deployed services, so a repo-wide grep for another board producer finds nothing and that absence is
 * NOT evidence against this comment.
 *
 * 🔴 The cron string is the deployment. `/api/internal/get-jobs` publishes it to the external
 * scheduler, which registers the trigger — adding this to the `jobs` array in the run-jobs route with
 * a real cron IS the scheduling, and nothing in this repo reads `Job.cron` besides that endpoint.
 */
export const reactionWithdrawalDetection = createJob(
  'reaction-withdrawal-detection',
  '0 9 * * 1',
  async () => {
    return runReactionWithdrawalDetection({
      ch: defaultClickhouse(),
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom({ type: 'info', name, ...data }, 'moderation').catch(() => undefined),
    });
  },
  { lockExpiration: 10 * 60 }
);
