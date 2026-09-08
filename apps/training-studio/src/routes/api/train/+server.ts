import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { submitTraining, type TrainingRunInput } from '$lib/server/train';

// Submit the real training workflow(s) — one per run — and return their ids. This spends Buzz, so it's
// the single write in the whole flow. Runs submit in series and stop at the first failure: if NONE landed
// we 502 (the client is safe to retry the whole batch); if some already landed we return those ids with
// 200 so the client navigates to them instead of re-submitting — and re-charging — the successful runs.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Training is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as { runs?: TrainingRunInput[] } | null;
  const runs = body?.runs;
  if (!runs?.length || runs.some((r) => !r?.items?.length || !r.ecosystem)) {
    error(400, 'Bad training request.');
  }

  const workflowIds: string[] = [];
  try {
    for (const run of runs) workflowIds.push(await submitTraining(token, run, locals.user.id));
  } catch (err) {
    console.warn('[training-studio] submitTraining failed', err);
    // Nothing landed → clean failure, safe to retry the whole batch. Some landed → fall through and return
    // them, so the already-charged runs are never re-submitted.
    if (workflowIds.length === 0) error(502, 'Could not start training. Try again.');
  }

  return json({ workflowIds, requested: runs.length });
};
