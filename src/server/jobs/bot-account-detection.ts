import { logToAxiom } from '~/server/logging/client';
import { createCohortReader } from '~/server/services/bot-account-detection/cohort';
import { createEvidenceReader } from '~/server/services/bot-account-detection/evidence';
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
 * 🔴 SCHEDULED DAILY — this replaced `UNRUNNABLE_JOB_CRON`, and the two preconditions that choice
 * was waiting on have since been CONFIRMED LIVE by an on-demand run that completed and landed a run
 * row on the board: the abuse-detection schema is applied on the moderator database (a missing
 * `(detector, started_at)` unique index would have 500'd the POST on a `42P10`), and
 * `MOD_INBOUND_TOKEN` is set. Those were the whole of the "daily 500 repeating until somebody
 * notices" risk that kept this unscheduled, and they were verified by execution rather than by
 * reading config. `/api/internal/get-jobs` publishes this cron to the external scheduler, so the
 * string below is the deployment — changing it changes when this runs in production.
 *
 * 🔴 THE CADENCE IS PINNED TO THE COHORT WINDOW. `BOT_ACCOUNT_COHORT_WINDOW_HOURS` is 24 and the run
 * does NOT dedupe against findings from earlier runs, so a cadence faster than the window re-reports
 * the same accounts once per run — the board would fill with duplicates of one cohort. Daily makes
 * cadence and window equal. If the window is ever changed, change this with it, or add dedupe first.
 *
 * 🔴 THAT TILES THE **REGISTRATION** AXIS EXACTLY ONCE — IT IS NOT FULL DETECTION COVERAGE, AND
 * DAILY IS THE SETTING THAT MAXIMISES THE GAP. The window filters `createdAt`, but membership also
 * requires the account to have posted BY THE TIME THE RUN LOOKS. An account that registers at 11:00
 * and first posts at 13:00 is not a member at the 12:00 run, and by the next run its `createdAt` is
 * 25 h old and outside the window — so no run ever scores it. The dormant-then-burst account is a
 * pattern this detector would want, and its grace period is `next_run − registration_time`: on
 * average 12 h, sometimes minutes.
 *
 * This is a REAL COST OF DAILY, not an argument for it. A faster cadence WITH cross-run dedupe would
 * strictly dominate on detection; that is more work than this change, and it is the honest reason
 * daily is chosen here rather than an inherent virtue of daily. Do not read the paragraph above as
 * saying the cohort is fully covered — it says only that no account is scored twice.
 *
 * Still SHADOW MODE: scheduling changes only how often the scoring runs, not what it may do. The run
 * holds no write client and no restriction service, and `actioned: false` is a literal in
 * `report.ts` — see the paragraph above about turning it live being a code change, not a flag.
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
  // Daily, and daily specifically because the cohort window is 24h with no cross-run dedupe.
  //
  // Noon UTC keeps it clear of the two sibling detectors that write the same board on the 11:00 and
  // 11:30 UTC hours. 🔴 Those run OUT OF THIS REPO, as their own deployed services — so a repo-wide
  // grep for another board producer finds nothing and that absence is NOT evidence against this
  // comment; an audit round read it that way. Their schedules were confirmed from their own run rows
  // on the board, which is the surface where all three are visible at once.
  '0 12 * * *',
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
