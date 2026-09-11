import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { listGenerations } from '$lib/server/orchestrator';
import type { Media } from '$lib/data/trainingModels';

const MEDIA: readonly Media[] = ['image', 'video', 'audio'];
const isMedia = (v: string | null): v is Media =>
  v !== null && (MEDIA as readonly string[]).includes(v);

// The caller's recent generated media of one type, as pick-able blobs for the "From my generations"
// dataset source. Token stays server-side; the client gets only blob ids + presigned preview URLs.
export const GET: RequestHandler = async ({ locals, url }) => {
  const media = url.searchParams.get('media');
  if (!isMedia(media)) error(400, 'Unknown media type.');

  const token = await requireToken(
    locals,
    'Your generations are unavailable right now — no orchestrator token.'
  );

  try {
    return json({ items: await listGenerations(token, media) });
  } catch (err) {
    console.warn('[training-studio] listGenerations failed', err);
    error(502, 'Could not load your generations. Try again.');
  }
};
