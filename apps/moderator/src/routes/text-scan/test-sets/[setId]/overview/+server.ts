import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logAxiomError } from '$lib/server/axiom';
import { resumeRuns, runsDeps } from '$lib/server/text-scan-tests/deps';
import { routeId, setForView } from '$lib/server/text-scan-tests/guard';
import { setOverview } from '$lib/server/text-scan-tests/reports';
import { TestSetError } from '$lib/server/text-scan-tests/store';
import { requestCookie } from '$lib/server/user-actions.service';

export const GET: RequestHandler = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  try {
    const deps = runsDeps(requestCookie());
    await setForView(deps.db, locals.user, setId);
    // Inside this request: a resumed worker forwards this viewer's session to the harness.
    void resumeRuns(locals.user).catch((e) =>
      logAxiomError(e, { event: 'text-scan test run resume failed', setId })
    );
    return json(await setOverview(deps, setId));
  } catch (e) {
    if (e instanceof TestSetError) error(e.status, e.message);
    throw e;
  }
};
