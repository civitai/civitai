import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAbuseFindings, getAbuseRuns } from '$lib/server/abuse-detection.service';

export const load: PageServerLoad = async ({ params }) => {
  const runId = Number(params.runId);
  // Bounded as well as integer-checked: `id` is `bigserial`, but an absurd value still costs a query,
  // and `Number('1e999')` is `Infinity`, which is neither NaN nor a safe integer.
  if (!Number.isSafeInteger(runId) || runId <= 0) throw error(404, 'No such run.');

  try {
    // Cheap because the list query is already indexed on (detector, started_at) and this filters to
    // one id in memory — a dedicated single-run getter would be a third query shape for one row.
    const [runs, findings] = await Promise.all([
      getAbuseRuns({ limit: 500 }),
      getAbuseFindings(runId),
    ]);
    const run = runs.find((r) => r.id === runId);
    if (!run) throw error(404, 'No such run.');
    return { run, findings };
  } catch (e) {
    // A SvelteKit `error()` carries a numeric status; rethrow it rather than reporting a missing run
    // as a database outage. Anything else genuinely is one.
    if (typeof (e as { status?: number }).status === 'number') throw e;
    console.error('[abuse-detection] run load failed', e);
    throw error(503, 'Could not read the abuse-detection tables.');
  }
};
