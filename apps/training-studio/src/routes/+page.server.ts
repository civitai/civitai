import type { PageServerLoad } from './$types';
import { listTrainingWorkflows } from '$lib/server/orchestrator';
import { orchestratorToken } from '$lib/server/orchestrator-token';
import { SAMPLE_ROWS, type TrainingRow } from '$lib/data/trainingRows';

export const load: PageServerLoad = async ({ locals }) => {
  // The dev-login stub isn't a real user: show the sample list so the UI is previewable.
  if (locals.devPreview) {
    return { username: locals.user.username, image: locals.user.image, rows: SAMPLE_ROWS };
  }

  // The list is where a user goes to find out what happened, so a blip degrades it to an empty list rather
  // than a 500. Pricing is loaded on the /new route (the flow), not here.
  let token: string | null = null;
  try {
    token = await orchestratorToken(locals.user.id);
  } catch (err) {
    console.warn('[training-studio] orchestratorToken failed', err);
  }

  const rows = token
    ? await listTrainingWorkflows(token).catch((err) => {
        console.warn('[training-studio] listTrainingWorkflows failed', err);
        return [] as TrainingRow[];
      })
    : [];

  return { username: locals.user.username, image: locals.user.image, rows };
};
