import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { reportPath } from '$lib/reports';
import {
  MODEL_FLAGS_APPEALS_PATH,
  MODEL_FLAGS_AUTO_PATH,
  MODEL_FLAGS_NEEDS_REVIEW_PATH,
} from '$lib/minor-flags/paths';
import { getModelPreview } from '$lib/server/model-preview.service';

// `ModelPreview`'s data, for the model report queue and every Model Flags tab, which are granted
// separately. `/api/*` is exempt from the global route gate, so this checks those pages itself.
// `report` only lets the preview leave the report being read out of "other reports on this model".
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const modelId = requireIdParam(
    locals,
    params.modelId,
    [
      reportPath('model'),
      MODEL_FLAGS_AUTO_PATH,
      MODEL_FLAGS_NEEDS_REVIEW_PATH,
      MODEL_FLAGS_APPEALS_PATH,
    ],
    'modelId'
  );
  const reportId = Number(url.searchParams.get('report')) || null;

  const preview = await getModelPreview(modelId, reportId);
  if (!preview) error(404, 'No such model.');
  return json(preview);
};
