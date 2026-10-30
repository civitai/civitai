import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { moderatorDbStatus } from '$lib/moderator-db-status';
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
  // The states are DISCRIMINATED rather than merged, because a page that hands the reader a list of
  // things it might be is not actually reporting a state. Postgres gives a deterministic code for
  // the two that matter, and an unset connection string is knowable before any query runs.
  try {
    const [runs, detectors] = await Promise.all([getAbuseRuns({ detector }), getAbuseDetectors()]);
    return { runs, detectors, detector, status: 'ok' as const };
  } catch (e) {
    console.error('[abuse-detection] load failed', e);
    // `42P01` = the DDL has never been applied here; `42501` = it was applied as the wrong role (the
    // natural `psql -U postgres` shortcut), which without its own state reads as "could not reach the
    // database" about a database the app is connected to. See `moderatorDbStatus`.
    return { runs: [], detectors: [], detector, status: moderatorDbStatus(e) };
  }
};
