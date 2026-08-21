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
  // nothing about which of "no data yet", "schema not applied" and "DB unreachable" they are looking
  // at. Do NOT replace this with a bare await: a page whose whole content is one table has no other
  // half to protect.
  //
  // The three states are DISCRIMINATED rather than merged, because a page that hands the reader a
  // list of things it might be is not actually reporting a state. Postgres gives a deterministic
  // code for the one that matters (`42P01` undefined_table), and an unset connection string is
  // knowable before any query runs.
  try {
    const [runs, detectors] = await Promise.all([getAbuseRuns({ detector }), getAbuseDetectors()]);
    return { runs, detectors, detector, status: 'ok' as const };
  } catch (e) {
    console.error('[abuse-detection] load failed', e);
    const code = (e as { code?: unknown }).code;
    const status =
      code === '42P01'
        ? ('no-schema' as const)
        : e instanceof Error && e.message.includes('MODERATOR_DATABASE_URL')
        ? ('not-configured' as const)
        : ('unreachable' as const);
    return { runs: [], detectors: [], detector, status };
  }
};
