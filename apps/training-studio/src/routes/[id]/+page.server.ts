import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrainingWorkflow } from '$lib/server/orchestrator';
import { orchestratorToken } from '$lib/server/orchestrator-token';
import { SAMPLE_DETAIL } from '$lib/data/trainingRows';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Lets the detail page re-run this load on a timer while the run is still training (live epochs).
  depends('app:training-detail');
  // The dev-login stub has no real token; show the sample detail so the screen is previewable.
  if (locals.devPreview) return { detail: SAMPLE_DETAIL, username: locals.user.username };

  let detail;
  try {
    const token = await orchestratorToken(locals.user.id);
    detail = await getTrainingWorkflow(token, params.id);
  } catch (err) {
    console.warn('[training-studio] getTrainingWorkflow failed', err);
    throw error(502, 'Could not load this training right now.');
  }
  if (!detail) throw error(404, 'Training not found.');
  return { detail, username: locals.user.username };
};
