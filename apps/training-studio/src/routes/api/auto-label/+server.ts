import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  submitAutoLabel,
  upstreamStatus,
  type AutoLabelItem,
  type AutoLabelMode,
} from '$lib/server/autolabel';
import type { Media } from '$lib/data/trainingModels';

// Submit one free auto-label workflow for a batch of uploaded blobs; returns its id for the client to
// poll via GET /api/auto-label/[id]. The main app submits it on the system token, so the user pays nothing.
export const POST: RequestHandler = async ({ locals, request }) => {
  // The dev-login preview has no main-app session to forward.
  if (locals.devPreview) error(503, 'Auto-labeling needs a main-app session (not in dev preview).');

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
    const workflowId = await submitAutoLabel(
      request.headers.get('cookie') ?? '',
      body.mode,
      body.media,
      body.items
    );
    return json({ workflowId });
  } catch (err) {
    console.warn('[training-studio] submitAutoLabel failed', err);
    error(upstreamStatus(err), 'Could not start auto-labeling. Try again.');
  }
};
