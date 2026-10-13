import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModeratorDb } from '$lib/server/moderator-db';
import { routeId, setForView } from '$lib/server/text-scan-tests/guard';
import { toRunView } from '$lib/server/text-scan-tests/reports';

export const GET: RequestHandler = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const runId = routeId(params.runId);
  const db = getModeratorDb();
  await setForView(db, locals.user, setId);
  const row = await db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('id', '=', String(runId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!row) error(404, 'Run not found.');
  return json(toRunView(row));
};
