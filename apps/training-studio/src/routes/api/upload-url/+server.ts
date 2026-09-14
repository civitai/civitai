import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { blobUploadUrl } from '$lib/server/orchestrator';

// Mints one presigned blob-upload URL per call; the browser POSTs the file to it directly. The
// orchestrator token stays server-side (same as pricing/listing) — the URL it returns is what the
// client is allowed to hold.
export const POST: RequestHandler = async ({ locals }) => {
  const token = await requireToken(
    locals,
    'Upload is unavailable right now — no orchestrator token.'
  );

  try {
    return json(await blobUploadUrl(token));
  } catch (err) {
    console.warn('[training-studio] blobUploadUrl failed', err);
    error(502, 'Could not start the upload. Try again.');
  }
};
