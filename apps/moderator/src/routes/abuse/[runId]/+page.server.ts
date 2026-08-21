import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAbuseFindings, getAbuseRun } from '$lib/server/abuse-detection.service';

export const load: PageServerLoad = async ({ params }) => {
  const runId = Number(params.runId);
  // `Number.isSafeInteger`, not just `!isNaN`: `Number('1e999')` is `Infinity`, which is neither NaN
  // nor a valid bigint id, and `id` is `bigserial` so an absurd value still costs a query.
  if (!Number.isSafeInteger(runId) || runId <= 0) throw error(404, 'No such run.');

  try {
    // A dedicated single-run read. Filtering a bounded list in memory made any run outside that
    // window 404 as "No such run" — false, and reachable long before the limit looks close.
    const [run, findings] = await Promise.all([getAbuseRun(runId), getAbuseFindings(runId)]);
    if (!run) throw error(404, 'No such run.');
    return { run, findings: findings.findings, truncated: findings.truncated };
  } catch (e) {
    // A SvelteKit `error()` carries a numeric status; rethrow it rather than reporting a missing run
    // as a database outage. Anything else genuinely is one.
    if (typeof (e as { status?: number }).status === 'number') throw e;
    console.error('[abuse-detection] run load failed', e);
    throw error(503, 'Could not read the abuse-detection tables.');
  }
};
