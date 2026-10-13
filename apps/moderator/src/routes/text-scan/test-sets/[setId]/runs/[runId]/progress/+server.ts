import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModeratorDb } from '$lib/server/moderator-db';
import { routeId, setForView, viewError } from '$lib/server/text-scan-tests/guard';
import { toRunView } from '$lib/server/text-scan-tests/reports';
import { getRun } from '$lib/server/text-scan-tests/store';

export const GET: RequestHandler = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const runId = routeId(params.runId);
  const db = getModeratorDb();
  await setForView(db, locals.user, setId);
  return json(toRunView(await getRun(db, setId, runId).catch(viewError)));
};
