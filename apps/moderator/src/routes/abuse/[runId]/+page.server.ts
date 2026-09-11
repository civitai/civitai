import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  getAbuseFindings,
  getAbuseRun,
  getAbuseVerdictSummary,
  recordAbuseVerdict,
} from '$lib/server/abuse-detection.service';
import { isAbuseVerdict } from '$lib/abuse-verdicts';

/** Shared by the load's 404 and the action's refusal, so the two cannot drift apart. */
const parseRunId = (raw: string): number | null => {
  const runId = Number(raw);
  // `Number.isSafeInteger`, not just `!isNaN`: `Number('1e999')` is `Infinity`, which is neither NaN
  // nor a valid bigint id, and `id` is `bigserial` so an absurd value still costs a query.
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
};

export const load: PageServerLoad = async ({ params }) => {
  const runId = parseRunId(params.runId);
  if (runId === null) throw error(404, 'No such run.');

  try {
    // A dedicated single-run read. Filtering a bounded list in memory made any run outside that
    // window 404 as "No such run" — false, and reachable long before the limit looks close.
    //
    // 🔴 `getAbuseVerdictSummary` answers `null` — it does NOT throw — on a deployment whose DDL has
    // not been applied, which is what keeps this page loading read-only in that window. It is in the
    // same `Promise.all` as the two reads the page cannot render without, so it must not be able to
    // fail them; that is a property of the service function, not of this call site.
    const [run, findings, verdicts] = await Promise.all([
      getAbuseRun(runId),
      getAbuseFindings(runId),
      getAbuseVerdictSummary(runId),
    ]);
    if (!run) throw error(404, 'No such run.');
    return { run, findings: findings.findings, truncated: findings.truncated, verdicts };
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

/**
 * The board's FIRST write, and the only one.
 *
 * 🔴 IT GRANTS NOTHING NEW. Whoever can open `/abuse` can rule; the page grant is enforced in
 * `hooks.server.ts` before any handler runs, so there is no permission check to add here and adding
 * one would be a second, drifting copy of the routing authority. Widening who reaches this board is
 * a separate, deliberate decision and is NOT made by this change.
 *
 * 🔴 CSRF IS THE FRAMEWORK'S, DELIBERATELY. SvelteKit refuses a cross-origin form POST at the
 * `csrf.checkOrigin` gate in `handle`, which is ON by default and which `svelte.config.js` does not
 * disable — the same protection every other form action in this app relies on. A hand-rolled token
 * here would be a second mechanism guarding one route while the other thirty rely on the first.
 */
export const actions: Actions = {
  verdict: async ({ request, params, locals }) => {
    const runId = parseRunId(params.runId);
    if (runId === null) return fail(400, { error: 'No such run.' });

    const form = await request.formData();
    const findingId = Number(form.get('findingId'));
    const verdict = form.get('verdict');

    // 🔴 VALIDATED AGAINST THE SAME TUPLE THE TABLE'S CHECK CONSTRAINT USES. Left unchecked, a
    // hand-posted value reaches the UPDATE and Postgres refuses it — a 500 on a moderator's click,
    // for an input this route could have named precisely.
    if (!isAbuseVerdict(verdict))
      return fail(400, { error: 'A verdict must be one of tp, fp or skip.' });
    if (!Number.isSafeInteger(findingId) || findingId <= 0)
      return fail(400, { error: 'Missing finding id.' });

    // The moderator's own name where there is one, their id where there is not. Never a display
    // string assembled here: this is an audit field, and it has to still identify someone after a
    // rename.
    const verdictBy = locals.user.username ?? String(locals.user.id);

    try {
      const { updated, groupKey } = await recordAbuseVerdict({
        runId,
        findingId,
        verdict,
        verdictBy,
      });
      // Zero rows is not success. It means the finding is not on this run — a stale page, or a post
      // aimed at another run — and reporting it as recorded would leave the moderator believing a
      // row was graded that was not.
      if (updated === 0)
        return fail(404, { error: 'That finding is not part of this run — reload the page.' });
      return { success: true, findingId, verdict, verdictBy, updated, groupKey };
    } catch (e) {
      console.error('[abuse-detection] verdict failed', e);
      // Refused, never swallowed — see `recordAbuseVerdict`. The message names the file to run,
      // because "the DDL is not applied here" is the overwhelmingly likely cause on a fresh deploy
      // and is otherwise indistinguishable from an outage.
      return fail(503, {
        error:
          e instanceof Error && e.message.includes('schema.sql')
            ? e.message
            : 'The verdict was NOT recorded — the database refused the write.',
      });
    }
  },
};
