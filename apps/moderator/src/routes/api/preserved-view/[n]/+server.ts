import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { heldMediaHeaders } from '@civitai/shared/held-media';
import { PRESERVED_VIEW_HEADER } from '$lib/preserved-view';
import { OversizeObjectError } from '$lib/server/preserved-object-store';
import {
  auditServe,
  errorName,
  openPreservedFilesOrError,
  parseFileNumber,
  preservedVerdicts,
  recordDelivery,
  recordPreservedServe,
  requirePreservedReviewer,
  sha256Hex,
  sniffImageType,
} from '$lib/server/preserved-view';

const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * One preserved file, for its named reviewers. The browser names a file number and nothing else: the
 * key, size and hash come from the pinned manifest.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
  // SvelteKit answers HEAD with this handler, which would audit and fetch for a response with no body.
  if (request.method === 'HEAD') return new Response(null, { status: 405 });
  const { config, reviewerId } = requirePreservedReviewer(locals);
  const n = parseFileNumber(params.n);
  if (!n || url.search) error(404, 'Not found.');
  // Only the review page's own fetch sends the header. An <img> anywhere in this app, an author's
  // embed included, cannot, so it cannot write a view the reviewer did not ask for.
  if (
    request.headers.get('sec-fetch-site') !== 'same-origin' ||
    request.headers.get(PRESERVED_VIEW_HEADER) !== 'open'
  )
    error(403, 'Open this file from its review page.');

  const opened = await openPreservedFilesOrError(config);
  const file = opened.files.find((f) => f.n === n);
  if (!file) error(404, 'Not found.');
  const ruled = async () => (await preservedVerdicts([file], config.reviewerIds)).has(n);
  if (await ruled()) error(410, 'This file has a verdict and is no longer served.');

  if (!(await auditServe(file, reviewerId))) error(503, 'Could not record this view.');
  const log = (
    status: number,
    bytes: Uint8Array | null,
    sizeMatch: boolean | null,
    sha256Match: boolean | null
  ) =>
    recordPreservedServe({
      reviewerId,
      n,
      status,
      bytes: bytes?.byteLength ?? null,
      sizeMatch,
      sha256Match,
    });

  // A verdict can land while the served row is written; the delivered row closes the later window.
  if (await ruled()) {
    log(410, null, null, null);
    error(410, 'This file has a verdict and is no longer served.');
  }

  const bytes = await opened.read(file, request.signal).catch((e: unknown) => {
    if (e instanceof OversizeObjectError) return 'oversize' as const;
    console.error('[preserved-view] file read failed', errorName(e));
    return undefined;
  });
  if (bytes === undefined || bytes === null) {
    const status = bytes === null ? 404 : 502;
    log(status, null, null, null);
    return new Response(null, { status, headers: NO_STORE });
  }
  if (bytes === 'oversize') {
    log(409, null, false, null);
    return new Response(null, { status: 409, headers: NO_STORE });
  }
  const sizeMatch = bytes.byteLength === file.size;
  const sha256Match = sizeMatch && sha256Hex(bytes) === file.sha256;
  const contentType = sha256Match ? sniffImageType(bytes) : null;
  if (!contentType) {
    const status = sha256Match ? 415 : 409;
    log(status, bytes, sizeMatch, sha256Match);
    return new Response(null, { status, headers: NO_STORE });
  }
  const delivery = await recordDelivery(file, reviewerId, config.reviewerIds);
  if (delivery !== 'delivered') {
    const status = delivery === 'ruled' ? 410 : 503;
    log(status, bytes, sizeMatch, sha256Match);
    error(
      status,
      delivery === 'ruled'
        ? 'This file has a verdict and is no longer served.'
        : 'Could not record this view.'
    );
  }
  log(200, bytes, sizeMatch, sha256Match);

  const headers = heldMediaHeaders(
    contentType,
    new Headers({ 'content-length': String(bytes.byteLength) })
  );
  headers['accept-ranges'] = 'none';
  return new Response(bytes, { status: 200, headers });
};
