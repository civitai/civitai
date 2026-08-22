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
  // The states are DISCRIMINATED rather than merged, because a page that hands the reader a list of
  // things it might be is not actually reporting a state. Postgres gives a deterministic code for
  // the two that matter, and an unset connection string is knowable before any query runs.
  try {
    const [runs, detectors] = await Promise.all([getAbuseRuns({ detector }), getAbuseDetectors()]);
    return { runs, detectors, detector, status: 'ok' as const };
  } catch (e) {
    console.error('[abuse-detection] load failed', e);
    const code = (e as { code?: unknown }).code;
    // `42P01` undefined_table — the DDL has never been applied here.
    if (code === '42P01')
      return { runs: [], detectors: [], detector, status: 'no-schema' as const };
    // 🔴 `42501` insufficient_privilege, and it is here because the DDL's natural operator shortcut
    // produces it. The app connects as role `internal_tools`; applying schema.sql as `postgres` —
    // i.e. `kubectl exec … psql -U postgres` — creates postgres-owned tables with no grant to that
    // role. Without this branch the page reports "could not reach the database" about a database it
    // is connected to, which is the misdiagnosis these statuses exist to prevent.
    if (code === '42501') return { runs: [], detectors: [], detector, status: 'no-grant' as const };
    if (e instanceof Error && e.message.includes('DATABASE_URL'))
      return { runs: [], detectors: [], detector, status: 'not-configured' as const };
    return { runs: [], detectors: [], detector, status: 'unreachable' as const };
  }
};
