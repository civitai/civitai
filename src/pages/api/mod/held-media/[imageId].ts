import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as z from 'zod';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
  isFullViewOpen,
} from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getHeldMedia } from '~/server/services/held-media.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';
import { getGetUrlByKey, getImageUploadBackend } from '~/utils/s3-utils';

export const config = { api: { responseLimit: false } };

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

/**
 * A CSAM-queue image or video for the CSAM report page, from storage rather than the public CDN.
 * The browser names an image id and nothing else; the key comes from the row, and only for an image
 * in the review queue or of an owner under a legal hold. The moderator app's `/api/held-media` is the
 * same route for its review grid.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad image id' });
  const { imageId } = parsed.data;

  const media = await getHeldMedia(imageId);
  if (!media || !isProbeableMediaKey(media.url))
    return void res.status(404).json({ error: 'Not available here' });

  let signedUrl: string;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    ({ url: signedUrl } = await getGetUrlByKey(media.url, { s3, bucket, expiresIn: 60 }));
  } catch (e) {
    console.error('[held-media] presign failed', e);
    return void res.status(502).json({ error: 'Could not reach storage' });
  }

  const range = forwardableRange(req.headers.range);
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  const upstream = await fetch(signedUrl, {
    headers: range ? { range } : {},
    signal: abort.signal,
  }).catch((e) => {
    console.error('[held-media] fetch failed', e);
    return null;
  });
  if (!upstream) return void res.status(502).json({ error: 'Could not reach storage' });
  if (upstream.status === 404)
    return void res.status(404).json({ error: 'The file is not in storage' });
  if (upstream.status === 416) {
    res.writeHead(416, heldMediaHeaders('application/octet-stream', upstream.headers));
    return void res.end();
  }
  if ((upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
    console.error('[held-media] upstream refused', upstream.status);
    void upstream.body?.cancel();
    return void res
      .status(502)
      .json({ error: `Storage would not serve this file (${upstream.status})` });
  }

  const contentType = heldMediaContentType(media.type, [
    upstream.headers.get('content-type'),
    media.mimeType,
  ]);
  if (!contentType) {
    void upstream.body.cancel();
    return void res.status(415).json({ error: 'This video type does not play in a browser' });
  }

  const view = typeof req.query.view === 'string' ? req.query.view : null;
  if (isFullViewOpen(view, range)) {
    void trackModActivity(user.id, {
      entityType: 'image',
      entityId: imageId,
      activity: 'heldMedia:view',
    }).catch((e) => console.error('[held-media] audit row failed', e));
    logToAxiom({ type: 'info', name: 'held-media-view', moderatorId: user.id, imageId }).catch(
      () => null
    );
  }

  res.writeHead(upstream.status, heldMediaHeaders(contentType, upstream.headers));
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res).catch((e) => {
    if (!abort.signal.aborted) console.error('[held-media] stream failed', e);
  });
}

export default ModEndpoint(handler);
