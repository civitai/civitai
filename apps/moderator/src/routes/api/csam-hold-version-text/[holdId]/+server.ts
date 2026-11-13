import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { getHoldVersionTexts } from '$lib/server/csam-holds.queries';

// Fetched when the moderator asks to see a flagged string: the same grant as the held text itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, '/csam/text-holds', 'holdId');
  requirePermission(locals, 'csam.report.file');

  const hits = await getHoldVersionTexts(holdId).catch((err) => {
    // Name only: a database error message can echo the text it was reading.
    console.error('CSAM hold version text lookup failed', { holdId, errorName: err?.name });
    error(500, 'Could not load the flagged version text.');
  });
  if (!hits) error(404, 'No flagged version text on this hold.');
  return json({ hits }, { headers: { 'cache-control': 'no-store' } });
};
