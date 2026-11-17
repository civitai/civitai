import { error, json } from '@sveltejs/kit';
import { denied } from '$lib/server/access';
import { exportUnsent } from '$lib/server/cases/backlog-import';
import { pauseSends } from '$lib/server/cases/brake';
import { withCaseData } from '$lib/server/cases/case-routes';
import { BATCH_ID } from '$lib/server/cases/cases.db';
import type { RequestHandler } from './$types';

/**
 * The batch's unsent rows for the fallback sender: row ids and notice ids, no addresses.
 *
 * Exporting pauses in-app sends first: from here the fallback may send these rows, and until its
 * sent.jsonl is imported they still read as unsent, so a send from the app would repeat them. A
 * `cases.unpause` holder resumes once the import is done.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.grants['cases.act']) error(403, denied('cases.act'));
  if (!BATCH_ID.test(params.batchId)) error(404, 'Unknown batch.');
  await pauseSends(
    locals.user.id,
    `unsent rows of batch ${params.batchId} exported for the fallback sender`
  );
  const rows = await withCaseData(() => exportUnsent(params.batchId));
  if (!rows.ok) error(503, rows.message);
  return json(rows.value, {
    headers: { 'content-disposition': `attachment; filename="${params.batchId}-unsent.json"` },
  });
};
