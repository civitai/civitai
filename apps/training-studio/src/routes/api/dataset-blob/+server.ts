import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';

// Serve one of the caller's dataset blobs for the detail-page gallery. The workflow stores each image as a
// blob `air` (a bare key, or an unsigned `/v2/consumer/blobs/{key}.ext` URL); neither is directly viewable,
// so we proxy the orchestrator's authenticated GET (`/v2/consumer/blobs/{blobId}`) with the user's token.
// The token scopes to the caller, so this only ever serves the caller's own blobs. `<img loading="lazy">`
// on the page means only the blobs actually scrolled into view are fetched.

/** Reduce a dataset `air` to the blob id the consumer endpoint wants. Three stored forms: an uploaded blob
 *  is an AIR URN (`urn:air:…:blob@<key>` — the key is after `@`); a generation is a full
 *  `/v2/consumer/blobs/{key}.ext` URL (the key is the last path segment); anything else is already a bare
 *  key. Query/signature is stripped in every case. */
function blobIdFromAir(air: string): string {
  const marker = '/v2/consumer/blobs/';
  const idx = air.indexOf(marker);
  if (idx >= 0) return air.slice(idx + marker.length).split('?')[0];
  if (air.startsWith('urn:air:')) return (air.split('@').pop() ?? air).split('?')[0];
  return air.split('?')[0];
}

export const GET: RequestHandler = async ({ locals, url, fetch }) => {
  const air = url.searchParams.get('air');
  const workflowId = url.searchParams.get('workflowId');
  if (!air) error(400, 'Missing blob air.');

  const token = await requireToken(locals, 'Dataset is unavailable right now.');
  const base = env.ORCHESTRATOR_ENDPOINT?.replace(/\/+$/, '');
  if (!base) error(502, 'Orchestrator not configured.');

  const blobId = encodeURIComponent(blobIdFromAir(air));
  const target = `${base}/v2/consumer/blobs/${blobId}${
    workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
  }`;

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    console.warn('[training-studio] dataset blob fetch failed', err);
    error(502, 'Dataset image unavailable.');
  }
  if (upstream.status === 404) error(404, 'Dataset image not found.');
  if (!upstream.ok || !upstream.body) error(502, 'Dataset image unavailable.');

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      // Blobs are immutable per key; let the browser cache within the session (private — it's the user's data).
      'cache-control': 'private, max-age=3600',
    },
  });
};
