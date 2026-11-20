import { createJob, getJobDate } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  autoCancelServiceDeals,
  autoCompleteServiceDeals,
  cancelOverdueServiceDeals,
  expireServiceDeals,
  remindServiceDeals,
} from '~/server/services/creator-service-deal.service';
import { reconcileServiceDealReviews } from '~/server/services/creator-service-deal-review-reconcile';
import {
  reconcileUnconfirmedHolds,
  sweepServiceDealRefunds,
  sweepServiceDealReleases,
} from '~/server/services/creator-service-escrow.service';

const BATCH = 100;
const REMINDERS_SINCE = 'creator-service-deal-reminders';
const REVIEW_COUNTERS_SINCE = 'creator-service-deal-review-counters';

/**
 * Every Creator Services deadline and the escrow's recovery, in dependency order: settle unknown
 * holds first (so a deal that is about to expire knows whether there is anything to refund), then
 * the timed transitions, then the releases and refunds those made due.
 *
 * Deliberately NOT behind the `creatorServices` flag. A dark flag must not freeze Buzz already
 * held: expiries, auto-cancels and refunds keep running for deals made while it was on.
 */
export const creatorServiceDealsJob = createJob(
  'creator-service-deals',
  '*/5 * * * *',
  async (jobContext) => {
    const holds = await reconcileUnconfirmedHolds({ limit: BATCH });
    jobContext.checkIfCanceled();
    const expired = await expireServiceDeals({ limit: BATCH });
    const completed = await autoCompleteServiceDeals({ limit: BATCH });
    const cancelled = await autoCancelServiceDeals({ limit: BATCH });
    const overdue = await cancelOverdueServiceDeals({ limit: BATCH });
    // After the transitions, so a deal that just completed or canceled is not reminded.
    const [since, setSince] = await getJobDate(REMINDERS_SINCE, new Date(Date.now() - 60 * 60_000));
    const upTo = new Date();
    // A failed run keeps its window for the next one, and must not hold up the payouts below.
    const reminded = await remindServiceDeals({ since, upTo })
      .then(async (sent) => {
        await setSince(upTo);
        return sent;
      })
      .catch((error) => {
        logToAxiom({
          name: 'creator-service-deal',
          type: 'error',
          message: 'deal reminders failed',
          error: (error as Error)?.message,
        });
        return 0;
      });
    jobContext.checkIfCanceled();
    const releases = await sweepServiceDealReleases({ limit: BATCH });
    // Last: its gauge counts every exhausted leg, the releases' included.
    const refunds = await sweepServiceDealRefunds({ limit: BATCH });
    // After the payouts, so its read-back sees this run's releases. Counters are recounted hourly.
    const [countersAt, setCountersAt] = await getJobDate(REVIEW_COUNTERS_SINCE, new Date(0));
    const counters = Date.now() - countersAt.getTime() >= 60 * 60_000;
    const reviews = await reconcileServiceDealReviews({ limit: BATCH, counters })
      .then(async (result) => {
        if (counters) await setCountersAt(new Date());
        return result;
      })
      .catch((error) => {
        logToAxiom({
          name: 'creator-service-deal',
          type: 'error',
          message: 'review reconcile failed',
          error: (error as Error)?.message,
        });
        return null;
      });
    return { holds, expired, completed, cancelled, overdue, reminded, releases, refunds, reviews };
  },
  { lockExpiration: 30 * 60 }
);

export const creatorServiceDealJobs = [creatorServiceDealsJob];
