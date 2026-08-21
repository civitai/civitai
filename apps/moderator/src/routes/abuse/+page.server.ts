import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getAbuseDetectors, getAbuseRuns } from '$lib/server/abuse-detection.service';

const querySchema = z.object({
  // `.catch` rather than a refine: an unknown detector in the URL should show everything, not 400 a
  // moderator out of the page because a bookmarked filter named a producer that has since stopped.
  detector: z.string().max(64).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { detector } = parseQuery(url, querySchema);

  // 🔴 Degrades rather than throws. `abuse-detection/schema.sql` is applied BY HAND, so between this
  // deploying and someone running it the tables do not exist — and a 500 there tells the operator
  // nothing about which of "no data yet", "DB unreachable" and "schema not applied" they are looking
  // at. `available: false` renders the instruction instead. Do NOT replace this with a bare await:
  // a page whose whole content is one table has no other half to protect.
  try {
    const [runs, detectors] = await Promise.all([getAbuseRuns({ detector }), getAbuseDetectors()]);
    return { runs, detectors, detector, available: true as const };
  } catch (e) {
    console.error('[abuse-detection] load failed', e);
    return { runs: [], detectors: [], detector, available: false as const };
  }
};
