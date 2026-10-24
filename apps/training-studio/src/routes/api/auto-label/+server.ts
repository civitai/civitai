import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { submitAutoLabel, type AutoLabelItem, type AutoLabelMode } from '$lib/server/autolabel';
import type { Media } from '$lib/data/trainingModels';

// Submit one free auto-label workflow for a batch of uploaded blobs; returns its id for the client to
// poll via GET /api/auto-label/[id].
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Auto-labeling is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as {
    mode?: AutoLabelMode;
    media?: Media;
    items?: AutoLabelItem[];
  } | null;
  if (
    !body?.items?.length ||
    (body.mode !== 'tag' && body.mode !== 'caption') ||
    !body.media ||
    body.items.some((i) => !i?.mediaUrl || !i?.key)
  ) {
    error(400, 'Bad auto-label request.');
  }

  try {
    const workflowId = await submitAutoLabel(token, body.mode, body.media, body.items);
    return json({ workflowId });
  } catch (err) {
    console.warn('[training-studio] submitAutoLabel failed', err);
    error(502, 'Could not start auto-labeling. Try again.');
  }
};
