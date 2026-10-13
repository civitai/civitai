import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { kickResume, runsDeps } from '$lib/server/text-scan-tests/deps';
import { routeId, setForView, viewError } from '$lib/server/text-scan-tests/guard';
import { setOverview } from '$lib/server/text-scan-tests/reports';
import { requestCookie } from '$lib/server/user-actions.service';

export const GET: RequestHandler = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  try {
    const deps = runsDeps(requestCookie());
    await setForView(deps.db, locals.user, setId);
    kickResume(locals.user, setId);
    return json(await setOverview(deps, setId));
  } catch (e) {
    viewError(e);
  }
};
