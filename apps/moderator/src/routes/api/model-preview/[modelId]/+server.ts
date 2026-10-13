import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { reportPath } from '$lib/reports';
import { getModelPreview } from '$lib/server/model-preview.service';

// The model-reports panel's preview, fetched when a report is selected. `/api/*` is exempt from the
// global route gate, so this checks the page it serves itself. `report` only lets the preview leave
// the report being read out of "other reports on this model".
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const modelId = requireIdParam(locals, params.modelId, reportPath('model'), 'modelId');
  const reportId = Number(url.searchParams.get('report')) || null;

  const preview = await getModelPreview(modelId, reportId);
  if (!preview) error(404, 'No such model.');
  return json(preview);
};
