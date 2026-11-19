import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { heldMediaHeaders } from '@civitai/shared/held-media';
import {
  auditServe,
  ManifestRefusedError,
  openPreservedFiles,
  parseFileNumber,
  preservedVerdicts,
  recordPreservedServe,
  requirePreservedReviewer,
  sha256Hex,
  sniffImageType,
} from '$lib/server/preserved-view';

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

  const opened = await openPreservedFiles(config).catch((e: unknown) => {
    if (e instanceof ManifestRefusedError) {
      console.error('[preserved-view] manifest refused', e.reason);
      return 'refused' as const;
    }
    console.error('[preserved-view] manifest read failed', e);
    return null;
  });
  if (opened === 'refused') error(409, 'The manifest does not match its pin.');
  if (!opened) error(502, 'Could not reach storage.');
  const file = opened.files.find((f) => f.n === n);
  if (!file) error(404, 'Not found.');
  if ((await preservedVerdicts()).has(n)) error(410, 'This file has a verdict and is no longer served.');

  if (!(await auditServe(reviewerId, n))) error(503, 'Could not record this view.');

  const bytes = await opened.read(file, request.signal).catch((e: unknown) => {
    console.error('[preserved-view] file read failed', e);
    return undefined;
  });
  if (bytes === undefined) error(502, 'Could not reach storage.');
  if (bytes === null) error(404, 'The file is not in storage.');

  const sizeMatch = bytes.byteLength === file.size;
  const sha256Match = sizeMatch && sha256Hex(bytes) === file.sha256;
  const contentType = sha256Match ? sniffImageType(bytes) : null;
  const status = !sha256Match ? 409 : contentType ? 200 : 415;
  recordPreservedServe({ reviewerId, n, status, bytes: bytes.byteLength, sizeMatch, sha256Match });
  if (!sha256Match || !contentType)
    return new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });

  const headers = heldMediaHeaders(
    contentType,
    new Headers({ 'content-length': String(bytes.byteLength) })
  );
  headers['accept-ranges'] = 'none';
  return new Response(bytes, { status: 200, headers });
};
