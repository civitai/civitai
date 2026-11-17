import { error, json } from '@sveltejs/kit';
import { denied } from '$lib/server/access';
import { exportUnsent } from '$lib/server/cases/backlog-import';
import type { RequestHandler } from './$types';

/** The batch's unsent rows for the fallback sender: row ids and notice ids, no addresses. */
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.grants['cases.act']) error(403, denied('cases.act'));
  if (!/^[a-z0-9-]{3,60}$/.test(params.batchId)) error(404, 'Unknown batch.');
  return json(await exportUnsent(params.batchId), {
    headers: { 'content-disposition': `attachment; filename="${params.batchId}-unsent.json"` },
  });
};
