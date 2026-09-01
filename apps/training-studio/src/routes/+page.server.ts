import type { PageServerLoad } from './$types';
import { listTrainingWorkflows } from '$lib/server/orchestrator';
import { orchestratorToken } from '$lib/server/orchestrator-token';
import { SAMPLE_ROWS, type TrainingRow } from '$lib/data/trainingRows';

export const load: PageServerLoad = async ({ locals }) => {
  // The hooks.server.ts guard guarantees a signed-in user on this gated route.
  const rows = await loadRows(locals);
  return { username: locals.user.username, rows };
};

async function loadRows(locals: App.Locals): Promise<TrainingRow[]> {
  // The dev-login stub isn't a real user; show the sample list so the UI is previewable.
  if (locals.devPreview) return SAMPLE_ROWS;

  // The list is where a user goes to find out what happened, so a DB/orchestrator blip degrades it to an
  // empty list rather than a 500. A run they can't see here is recoverable on the next load.
  try {
    const token = await orchestratorToken(locals.user.id);
    return await listTrainingWorkflows(token);
  } catch (err) {
    console.warn('[training-studio] listTrainingWorkflows failed', err);
    return [];
  }
}
