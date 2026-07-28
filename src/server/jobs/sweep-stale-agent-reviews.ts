import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks) — stale-`running`-report-row sweeper.
 *
 * `startAgentReview` inserts an `AppReviewAgentReport` row with status `running`,
 * and it is flipped OUT of `running` only when the agent's callback POSTs the
 * finished report (→ complete/failed/cost-capped) OR the mod-decision teardown
 * runs (→ torn-down). If neither happens — the review Job hits its
 * `activeDeadlineSeconds` without posting, its node reboots mid-run, or any
 * un-decided abandonment — the row is stranded `running` FOREVER. That is not
 * cosmetic: the double-provision guard (`startAgentReview` + the partial-unique
 * index on `publish_request_id WHERE status='running'`) then refuses every future
 * dispatch for that request with "a review is already running".
 *
 * This job flips rows that have been `running` past a generous ceiling → `failed`,
 * releasing the guard so a fresh review can be dispatched. The threshold (60m)
 * sits well beyond the Job's 30m `activeDeadlineSeconds` + the callback retry
 * window, so it can only ever catch a genuinely dead run — never a legitimately
 * in-flight one. NO schema change: it uses the existing `status` enum + `startedAt`.
 *
 * DARK-SAFE: with the `app-blocks-agentic-review` flag off (current state) no
 * report rows are ever created, so every run is a single indexed UPDATE matching
 * zero rows — an immediate no-op.
 */

/** A `running` row older than this is definitely dead (Job `activeDeadlineSeconds`
 *  is 30m; add margin for the callback retry window). */
export const STALE_AGENT_REVIEW_RUNNING_MS = 60 * 60 * 1000;

/**
 * Core sweep (exported for unit tests, mirroring reap-dev-tunnels' service-fn +
 * thin-job-wrapper split): flip any `running` report older than the cutoff →
 * `failed`. Returns the number of rows swept.
 */
export async function sweepStaleAgentReviews(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AGENT_REVIEW_RUNNING_MS);
  const { count } = await dbWrite.appReviewAgentReport.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: {
      status: 'failed',
      completedAt: now,
      summaryMd:
        'Review timed out — no report callback within the deadline; swept to ' +
        'failed by the stale-running-report reaper so the request can be re-run.',
    },
  });
  return count;
}

/**
 * FAIL-OPEN: a sweep failure must never mark the runner failed or page — it is a
 * best-effort janitor. We catch, log, and return a benign result; the next tick
 * retries.
 */
export const sweepStaleAgentReviewsJob = createJob(
  'sweep-stale-agent-reviews',
  '*/10 * * * *',
  async () => {
    try {
      const swept = await sweepStaleAgentReviews();
      if (swept > 0) {
        logToAxiom({ type: 'sweep-stale-agent-reviews', swept }, 'webhooks').catch(
          () => undefined
        );
      }
      return { swept };
    } catch (error) {
      logToAxiom(
        {
          type: 'sweep-stale-agent-reviews',
          level: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'webhooks'
      ).catch(() => undefined);
      return { swept: 0, error: true as const };
    }
  }
);
