import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { renameTraining } from '$lib/server/train';

// Rename one training. The token scopes to the caller, so this only touches the caller's own workflows.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Rename is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as {
    workflowId?: string;
    name?: string;
  } | null;
  if (!body?.workflowId || typeof body.name !== 'string' || !body.name.trim()) {
    error(400, 'A workflow id and a non-empty name are required.');
  }

  try {
    await renameTraining(token, body.workflowId, body.name);
  } catch (err) {
    console.warn('[training-studio] renameTraining failed', err);
    error(502, 'Could not rename this training.');
  }
  return json({ ok: true });
};
