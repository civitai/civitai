import { error, json } from '@sveltejs/kit';
import { batchCounts } from '$lib/server/cases/backlog-import';
import { withCaseData } from '$lib/server/cases/case-routes';
import { BATCH_ID } from '$lib/server/cases/cases.db';
import { isBatchRunning } from '$lib/server/cases/cases.service';
import type { RequestHandler } from './$types';

/** Per-notice counts and whether a send is running: what the batch page polls. No personal data. */
export const GET: RequestHandler = async ({ params }) => {
  if (!BATCH_ID.test(params.batchId)) error(404, 'Unknown batch.');
  const [running, counts] = await Promise.all([
    isBatchRunning(params.batchId),
    withCaseData(() => batchCounts(params.batchId)),
  ]);
  if (!counts.ok) error(503, counts.message);
  return json({ running, counts: counts.value });
};
