import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { fetchOrchestratorBlob } from '$lib/server/orchestrator';
import { resolveTrainingWorkflowBlob } from '$lib/server/training-moderation.service';
import { logToAxiom } from '$lib/server/axiom';

/**
 * One dataset item of a workflow-only training run, for the review page's thumbnails and viewer.
 *
 * The browser names a workflow and a POSITION; which blob that is comes from this app's own read of
 * the workflow. Nothing posted can choose what gets fetched, so this cannot be turned into a proxy for
 * an arbitrary URL or someone else's unrelated upload.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  // `/api/*` is exempt from the global page gate, so it carries the page's own check.
  if (!locals.user) error(403, 'Not signed in.');
  if (!canAccess(locals.user, '/audit/training-data'))
    error(403, 'You do not have access to this page.');

  const index = Number(params.index);
  if (!/^\d{1,4}$/.test(params.index) || !Number.isInteger(index)) error(400, 'Bad item index.');

  const resolved = await resolveTrainingWorkflowBlob(params.workflowId, index);
  if (!resolved.ok) error(resolved.status, resolved.error);

  const upstream = await fetchOrchestratorBlob(resolved.blobKey).catch((e) => {
    console.error('[training-workflow-blob] fetch failed', e);
    return null;
  });
  if (!upstream) error(502, 'Could not reach the orchestrator.');
  if (!upstream.ok || !upstream.body) {
    console.error('[training-workflow-blob] upstream refused', upstream.status);
    error(502, `The orchestrator would not serve this item (${upstream.status}).`);
  }

  // Dataset items are evidence on a held run; who viewed which is the only record of it on our side.
  void logToAxiom({
    name: 'training-workflow-blob',
    type: 'info',
    moderatorId: locals.user.id,
    workflowId: params.workflowId,
    ownerId: resolved.ownerId,
    index,
  }).catch(() => {});

  // User-uploaded bytes served from this app's origin: anything but plain media goes out as an opaque
  // download, never as something a browser would render as a document.
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
