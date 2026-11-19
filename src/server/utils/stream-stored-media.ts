import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import {
  fetchHeldObject,
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
  isAuditedServe,
} from '@civitai/shared/held-media';
import { getGetUrlByKey, getImageUploadBackend } from '~/utils/s3-utils';

/**
 * Streams one stored image or video from storage rather than the public CDN. `audit` runs, awaited,
 * before any response from byte 0 is sent (before every response carrying bytes with
 * `auditEveryRange`), and when it fails the answer is a 503 with no bytes. The caller has already
 * decided this moderator may see this image, and that its url is a storage key.
 */
export async function streamStoredMedia(
  req: NextApiRequest,
  res: NextApiResponse,
  input: {
    /** Log prefix, e.g. `held-media`. */
    label: string;
    media: { url: string; type: string; mimeType: string | null };
    audit: () => Promise<unknown>;
    /** Audit every response carrying bytes, mid-file ranges included, not just those from byte 0. */
    auditEveryRange?: boolean;
    /** Refuse, ranges included, an object larger than this, or of an unknown or encoded size. */
    maxBytes?: number;
    /** Abort the stream after this long. */
    streamMs?: number;
    /** Called for every response about to carry bytes, before the audit. */
    onServe?: (upstream: Response, range: string | null) => void;
  }
): Promise<void> {
  const { label, media } = input;
  let signedUrl: string;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    ({ url: signedUrl } = await getGetUrlByKey(media.url, { s3, bucket, expiresIn: 60 }));
  } catch (e) {
    console.error(`[${label}] presign failed`, e);
    return void res.status(502).json({ error: 'Could not reach storage' });
  }

  const range = forwardableRange(req.headers.range);
  // The response's close, not the request's: the body parser has consumed the request already.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const upstream = await fetchHeldObject(signedUrl, range, abort.signal).catch((e) => {
    if (!abort.signal.aborted) console.error(`[${label}] fetch failed`, e);
    return null;
  });
  if (!upstream) return void res.status(502).json({ error: 'Could not reach storage' });
  if (upstream.status === 404 || upstream.status === 416) void upstream.body?.cancel();
  if (upstream.status === 404)
    return void res.status(404).json({ error: 'The file is not in storage' });
  if (upstream.status === 416) {
    res.writeHead(416, heldMediaHeaders('application/octet-stream', upstream.headers, false));
    return void res.end();
  }
  if ((upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
    console.error(`[${label}] upstream refused`, upstream.status);
    void upstream.body?.cancel();
    return void res
      .status(502)
      .json({ error: `Storage would not serve this file (${upstream.status})` });
  }

  if (input.maxBytes !== undefined) {
    // Capped by the whole object, so a large one cannot be pulled in ranges, and an unknown or
    // encoded size counts as too large: the cap must hold before the first byte leaves.
    const length = Number(upstream.headers.get('content-length') ?? NaN);
    const total =
      upstream.status === 206
        ? Number(upstream.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? NaN)
        : length;
    if (
      upstream.headers.get('content-encoding') ||
      !Number.isFinite(length) ||
      !Number.isFinite(total) ||
      total > input.maxBytes
    ) {
      void upstream.body.cancel();
      return void res.status(413).json({ error: 'This file is too large to serve here' });
    }
  }

  const contentType = heldMediaContentType(media.type, [
    upstream.headers.get('content-type'),
    media.mimeType,
  ]);
  if (!contentType) {
    void upstream.body.cancel();
    return void res.status(415).json({ error: 'This video type does not play in a browser' });
  }

  input.onServe?.(upstream, range);
  // Awaited, so the row is there before the page that loads these bytes reports them shown.
  if (input.auditEveryRange || isAuditedServe(upstream)) {
    const written = await input.audit().then(
      () => true,
      (e) => {
        console.error(`[${label}] audit row failed`, e);
        return false;
      }
    );
    if (!written) {
      void upstream.body.cancel();
      return void res.status(503).json({ error: 'Could not record this view' });
    }
  }

  res.writeHead(upstream.status, heldMediaHeaders(contentType, upstream.headers));
  const deadline =
    input.streamMs !== undefined ? setTimeout(() => abort.abort(), input.streamMs) : undefined;
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res)
    .catch((e) => {
      if (!abort.signal.aborted) console.error(`[${label}] stream failed`, e);
    })
    .finally(() => clearTimeout(deadline));
}
