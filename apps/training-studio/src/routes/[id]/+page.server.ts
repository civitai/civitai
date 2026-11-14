import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrainingWorkflow } from '$lib/server/orchestrator';
import { orchestratorToken } from '$lib/server/orchestrator-token';
import { SAMPLE_DETAIL, workflowToDetail } from '$lib/data/trainingRows';
import { sampleReviewWorkflows } from '$lib/data/sampleReviewRuns';
import { askerOf, withheldRuns, withholdDetail } from '$lib/server/withheld';

export const load: PageServerLoad = async ({ locals, params, depends, request }) => {
  // Lets the detail page re-run this load on a timer while the run is still training (live epochs).
  depends('app:training-detail');
  // The dev-login stub has no real token; show the sample detail so the screen is previewable.
  if (locals.devPreview) {
    const held = sampleReviewWorkflows().find((w) => w.id === params.id);
    return {
      detail: (held && workflowToDetail(held)) || SAMPLE_DETAIL,
      username: locals.user.username,
      image: locals.user.image,
    };
  }

  let detail;
  let withheld: Set<string>;
  try {
    const token = await orchestratorToken(locals.user.id);
    [detail, withheld] = await Promise.all([
      getTrainingWorkflow(token, params.id),
      withheldRuns(askerOf({ locals, request }), [params.id]),
    ]);
  } catch (err) {
    console.warn('[training-studio] getTrainingWorkflow failed', err);
    throw error(502, 'Could not load this training right now.');
  }
  if (!detail) throw error(404, 'Training not found.');
  return {
    detail: withheld.has(params.id) ? withholdDetail(detail) : detail,
    username: locals.user.username,
    image: locals.user.image,
  };
};
