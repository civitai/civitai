import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mainAppModelLive } from '$lib/server/model-status';

export const GET: RequestHandler = async ({ locals, request, url }) => {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) error(400, 'Invalid model id.');
  // The dev-login preview has no session to ask the main app with.
  if (locals.devPreview) return json({ live: true });
  try {
    return json({ live: await mainAppModelLive(request.headers.get('cookie') ?? '')(id) });
  } catch {
    error(502, 'The model check is unavailable right now.');
  }
};
