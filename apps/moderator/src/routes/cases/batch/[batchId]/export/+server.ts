import { error, json } from '@sveltejs/kit';
import { denied } from '$lib/server/access';
import { ImportRefusedError } from '$lib/server/cases/backlog-import';
import { withCaseData } from '$lib/server/cases/case-routes';
import { BATCH_ID } from '$lib/server/cases/cases.db';
import { startExport } from '$lib/server/cases/cases.service';
import type { RequestHandler } from './$types';

/**
 * The batch's unsent rows for the fallback sender: row ids and notice ids, no addresses.
 *
 * Exporting holds the batch's in-app sends until its sent.jsonl is imported: from here the fallback may
 * send these rows, and until then they still read as unsent, so a send from the app would repeat them.
 * Refused while a send of the batch runs. A POST, because it changes state: SvelteKit's origin check
 * covers form posts.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.grants['cases.act']) error(403, denied('cases.act'));
  if (!BATCH_ID.test(params.batchId)) error(404, 'Unknown batch.');
  let rows;
  try {
    rows = await withCaseData(() => startExport(params.batchId, locals.user.id));
  } catch (e) {
    if (e instanceof ImportRefusedError) error(409, e.message);
    throw e;
  }
  if (!rows.ok) error(503, rows.message);
  if (rows.value === 'running') error(409, 'A send of this batch is running; export once it ends.');
  return json(rows.value, {
    headers: { 'content-disposition': `attachment; filename="${params.batchId}-unsent.json"` },
  });
};
