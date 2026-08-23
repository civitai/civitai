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
    // Same discrimination as the list page. A flat "could not read the tables" here sends an
    // operator hunting a database outage when the tables have simply never been created.
    const code = (e as { code?: unknown }).code;
    if (code === '42P01')
      throw error(503, 'The abuse-detection tables do not exist yet — apply schema.sql.');
    // See the list page: created by the wrong role is a distinct, likely, and otherwise
    // indistinguishable-from-an-outage state.
    if (code === '42501')
      throw error(
        503,
        'The abuse-detection tables exist but this role cannot read them — re-run schema.sql as the application role.'
      );
    if (e instanceof Error && e.message.includes('DATABASE_URL'))
      throw error(503, 'MODERATOR_DATABASE_URL is not configured for this environment.');
    throw error(503, 'Could not reach the abuse-detection database.');
  }
};
