import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { fetchOrchestratorBlobContent, probeOrchestratorBlob } from '$lib/server/orchestrator';
import {
  resolveUploadBatchBlob,
  UPLOAD_BATCH_PAGE_PATH,
} from '$lib/server/app-upload-batches.service';
import { logToAxiom } from '$lib/server/axiom';

/**
 * One file of an App Blocks upload batch, for the audit page's previews.
 *
 * The browser names a batch and a POSITION; which blob that is comes from this app's own read of
 * the batch row. Nothing posted can choose what gets fetched, so this cannot be turned into a proxy
 * for an arbitrary URL or someone else's unrelated upload. A file the orchestrator's scan blocked is
 * refused rather than served as its placeholder.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  // API routes carry their page's check themselves (see `api-guard.ts`).
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, UPLOAD_BATCH_PAGE_PATH);

  const batchId = Number(params.batchId);
  if (!/^\d{1,10}$/.test(params.batchId) || !Number.isInteger(batchId) || batchId <= 0)
    error(400, 'Bad batch id.');
  const index = Number(params.index);
  if (!/^\d{1,4}$/.test(params.index) || !Number.isInteger(index)) error(400, 'Bad item index.');

  const resolved = await resolveUploadBatchBlob(batchId, index);
  if (!resolved.ok) error(resolved.status, resolved.error);

  const probe = await probeOrchestratorBlob(resolved.blobKey).catch((e) => {
    console.error('[app-upload-batch-blob] probe failed', e);
    return null;
  });
  if (!probe) error(502, 'Could not reach the orchestrator.');
  if (probe.kind === 'blocked') error(451, 'Blocked by screening — not viewable here.');
  if (probe.kind === 'unavailable')
    error(502, `The orchestrator would not serve this item (${probe.status}).`);

  const upstream = await fetchOrchestratorBlobContent(probe.url).catch((e) => {
    console.error('[app-upload-batch-blob] fetch failed', e);
    return null;
  });
  if (!upstream) error(502, 'Could not reach the orchestrator.');
  if (!upstream.ok || !upstream.body) {
    console.error('[app-upload-batch-blob] upstream refused', upstream.status);
    error(502, `The orchestrator would not serve this item (${upstream.status}).`);
  }

  // Private files: who viewed which is the only record of it on our side.
  void logToAxiom({
    name: 'app-upload-batch-blob',
    type: 'info',
    moderatorId: locals.user.id,
    batchId,
    ownerId: resolved.userId,
    index,
  }).catch(() => {});

  // User-uploaded bytes served from this app's origin: anything but plain media goes out as an
  // opaque download, never as something a browser would render as a document.
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const contentLength = upstream.headers.get('content-length');
  return new Response(upstream.body, {
    headers: {
      'content-type':
        /^(image|video|audio)\/[\w.+-]+$/.test(type) && type !== 'image/svg+xml'
          ? type
          : 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      ...(contentLength ? { 'content-length': contentLength } : {}),
      'cache-control': 'private, no-store',
    },
  });
};
