import { createJob } from './job';
import {
  autoCancelServiceDeals,
  autoCompleteServiceDeals,
  expireServiceDeals,
} from '~/server/services/creator-service-deal.service';
import {
  reconcileUnconfirmedHolds,
  sweepServiceDealRefunds,
  sweepServiceDealReleases,
} from '~/server/services/creator-service-escrow.service';

const BATCH = 100;

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
    jobContext.checkIfCanceled();
    const releases = await sweepServiceDealReleases({ limit: BATCH });
    // Last: its gauge counts every exhausted leg, the releases' included.
    const refunds = await sweepServiceDealRefunds({ limit: BATCH });
    return { holds, expired, completed, cancelled, releases, refunds };
  },
  { lockExpiration: 30 * 60 }
);

export const creatorServiceDealJobs = [creatorServiceDealsJob];
