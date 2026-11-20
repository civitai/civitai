import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { heldMediaHeaders } from '@civitai/shared/held-media';
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
 * One preserved file, for its one named reviewer. The browser names a file number and nothing else:
 * the key, size and hash come from the pinned manifest. Each response with bytes has an audit row
 * written and read back before the store is called.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
  // SvelteKit answers HEAD with this handler, which would audit and fetch for a response with no body.
  if (request.method === 'HEAD') return new Response(null, { status: 405 });
  const { config, reviewerId } = requirePreservedReviewer(locals);
  const n = parseFileNumber(params.n);
  if (!n || url.search) error(404, 'Not found.');
  // The session cookie is SameSite=Lax, so another page on the same site could make the browser
  // request this and write a view row the reviewer never saw.
  if (request.headers.get('sec-fetch-site') !== 'same-origin')
    error(403, 'Open this file from its review page.');

  const opened = await openPreservedFilesOrError(config);
  const file = opened.files.find((f) => f.n === n);
  if (!file) error(404, 'Not found.');
  const ruled = async () => (await preservedVerdicts(config)).has(n);
  if (await ruled()) error(410, 'This file has a verdict and is no longer served.');

  if (!(await auditServe(config, reviewerId, n))) error(503, 'Could not record this view.');
  // A verdict recorded since the check above.
  if (await ruled()) error(410, 'This file has a verdict and is no longer served.');

  const bytes = await opened.read(file, request.signal).catch((e: unknown) => {
    if (e instanceof OversizeObjectError) return 'oversize' as const;
    console.error('[preserved-view] file read failed', errorName(e));
    return undefined;
  });
  const sizeMatch = bytes instanceof Uint8Array ? bytes.byteLength === file.size : null;
  const sha256Match =
    bytes instanceof Uint8Array ? sizeMatch === true && sha256Hex(bytes) === file.sha256 : null;
  const contentType = bytes instanceof Uint8Array && sha256Match ? sniffImageType(bytes) : null;
  const status =
    bytes === undefined
      ? 502
      : bytes === null
      ? 404
      : bytes === 'oversize' || !sha256Match
      ? 409
      : contentType
      ? 200
      : 415;
  recordPreservedServe({
    reviewerId,
    n,
    status,
    bytes: bytes instanceof Uint8Array ? bytes.byteLength : null,
    sizeMatch: bytes === 'oversize' ? false : sizeMatch,
    sha256Match,
  });
  if (status !== 200 || !(bytes instanceof Uint8Array) || !contentType)
    return new Response(null, { status, headers: NO_STORE });

  if (!(await recordDelivery(config, reviewerId, n))) error(503, 'Could not record this view.');
  const headers = heldMediaHeaders(
    contentType,
    new Headers({ 'content-length': String(bytes.byteLength) })
  );
  headers['accept-ranges'] = 'none';
  return new Response(bytes, { status: 200, headers });
};
