import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { blobIdFromAir, consumerBlobUrl } from '$lib/orchestrator-core';
import { runDatasetKeys } from '$lib/server/run-dataset-keys';
import { askerOf, RunWithheldError } from '$lib/server/withheld';

// Serve one of the caller's dataset blobs for the detail-page gallery. The workflow stores each image as a
// blob `air` (a bare key, or an unsigned `/v2/consumer/blobs/{key}.ext` URL); neither is directly viewable,
// so we proxy the orchestrator's authenticated GET (`/v2/consumer/blobs/{blobId}`) with the user's token.
// Only a blob in the named run's own dataset is served; the run is read with the caller's token.

export const GET: RequestHandler = async ({ locals, request, url, fetch }) => {
  const air = url.searchParams.get('air');
  const workflowId = url.searchParams.get('workflowId');
  if (!air || !workflowId) error(400, 'Missing blob air or run id.');

  const token = await requireToken(locals, 'Dataset is unavailable right now.');
  if (!env.ORCHESTRATOR_ENDPOINT) error(502, 'Orchestrator not configured.');

  let keys: Set<string>;
  try {
    keys = await runDatasetKeys(token, askerOf({ locals, request }), workflowId);
  } catch (err) {
    if (err instanceof RunWithheldError) error(403, err.message);
    console.warn('[training-studio] dataset blob run read failed', err);
    error(502, 'Dataset image unavailable.');
  }
  if (!keys.has(blobIdFromAir(air))) error(404, 'Dataset image not found.');

  const target = consumerBlobUrl(env.ORCHESTRATOR_ENDPOINT, air, workflowId);

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    console.warn('[training-studio] dataset blob fetch failed', err);
    error(502, 'Dataset image unavailable.');
  }
  if (upstream.status === 404) error(404, 'Dataset image not found.');
  if (!upstream.ok || !upstream.body) error(502, 'Dataset image unavailable.');
  const contentType = upstream.headers.get('content-type') ?? '';
  // Only media is a dataset item; anything else (a weights file) is never streamed.
  if (!/^(image|video|audio)\//i.test(contentType)) {
    await upstream.body.cancel().catch(() => undefined);
    error(404, 'Dataset image not found.');
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': contentType,
      // Blobs are immutable per key; let the browser cache within the session (private — it's the user's data).
      'cache-control': 'private, max-age=3600',
    },
  });
};
