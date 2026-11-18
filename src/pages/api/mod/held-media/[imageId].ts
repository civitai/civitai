import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  heldServeRecord,
  NOT_HELD,
  NOT_HELD_HEADER,
  SERVED_ACTIVITY,
} from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getHeldMedia } from '~/server/services/held-media.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { streamStoredMedia } from '~/server/utils/stream-stored-media';
import type { SessionUser } from '~/types/session';

export const config = { api: { responseLimit: false } };

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

/**
 * A held image or video for the CSAM report page, from storage rather than the public CDN. The
 * browser names an image id and nothing else; the key comes from the row, and only for an image
 * `heldImageSql` holds. The moderator app's `/api/held-media` is the same route for its grid.
 *
 * `?probe=1` answers eligibility alone (204, or the not-held 404) and serves nothing, so the page can
 * tell "not held, use the CDN" from any other failure without fetching the file again.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  res.setHeader('cache-control', 'private, no-store');
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad image id' });
  const { imageId } = parsed.data;

  const media = await getHeldMedia(imageId);
  if (!media) {
    res.setHeader(NOT_HELD_HEADER, NOT_HELD);
    return void res.status(404).json({ error: 'Not available here' });
  }
  // Held, but not a key this store can serve: no not-held answer, so the page never shows the CDN copy.
  if (!isProbeableMediaKey(media.url))
    return void res.status(422).json({ error: 'This file is not in a servable place' });
  if (req.query.probe === '1') return void res.status(204).end();

  await streamStoredMedia(req, res, {
    label: 'held-media',
    media,
    audit: () =>
      trackModActivity(user.id, {
        entityType: 'image',
        entityId: imageId,
        activity: SERVED_ACTIVITY,
      }),
    onServe: (upstream, range) =>
      logToAxiom(
        heldServeRecord({
          moderatorId: user.id,
          imageId,
          status: upstream.status,
          range,
          upstream: upstream.headers,
        })
      ),
  });
}

export default ModEndpoint(handler);
