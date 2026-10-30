import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { recordModActivity } from '$lib/server/mod-activity';

/**
 * Streams a version's training-data zip so the review pages can unpack it in the browser.
 *
 * Two hops, and the split matters. The main app resolves the file — `ModelFile.url` reaches bytes via
 * the storage resolver with a delivery-worker fallback, and files live on more than one backend, so a
 * second implementation here would be a second thing to keep correct. This app then fetches those bytes
 * itself rather than redirecting the browser, because the signed URL is short-lived and the viewer needs
 * a same-origin response it can read progress from.
 *
 * `/api/mod/*` — so the resolve is authenticated as the MODERATOR asking, and inherits that family's
 * per-actor rate limit and audit row. A token-guarded route was tried and reverted: a service identity
 * disables exactly those controls, on what is CSAM-adjacent evidence.
 *
 * ⚠️ Like every other `/api/mod/*` call from this app, it therefore needs `CIVITAI_APP_URL` to name a
 * host that trusts this app's auth hub. In local development that means running the main app locally
 * and pointing at it; against a remote host the relayed session is not accepted and the resolve fails.
 */
export const GET: RequestHandler = async ({ params, locals, fetch }) => {
  // Both training pages open the viewer and are granted separately, so either grant admits.
  const versionId = requireIdParam(
    locals,
    params.versionId,
    ['/audit/training-data', '/audit/training-models'],
    'versionId'
  );

  const resolved = await callModEndpoint(
    'training-data/resolve',
    { modelVersionId: versionId },
    'Training data'
  );
  if (!resolved.ok) {
    console.error('[training-data] resolve failed', resolved.error);
    error(502, resolved.error);
  }

  const { url, name } = resolved.body as { url?: string; name?: string };
  if (!url) error(502, 'The resolver returned no download URL.');

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) {
    console.error('[training-data] storage fetch failed', upstream.status);
    error(502, `Training data download failed (${upstream.status}).`);
  }

  // The zip is evidence; who pulled it is worth having, and this is the only record on our side.
  void recordModActivity({
    userId: locals.user.id,
    entityType: 'modelVersion',
    entityId: versionId,
    activity: 'trainingData:download',
  });

  // Read once and reuse: forwarded only when the upstream sent it, since a wrong or absent
  // content-length on a streamed body is worse than none.
  const contentLength = upstream.headers.get('content-length');

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/zip',
      ...(contentLength ? { 'content-length': contentLength } : {}),
      'content-disposition': `attachment; filename="${(
        name ?? `training-data-${versionId}.zip`
      ).replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    },
  });
};
