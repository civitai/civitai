import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { SHOWN_ACTIONS, SHOWN_RENDITIONS, shownActivity } from '@civitai/shared/held-media';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getHeldMedia } from '~/server/services/held-media.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

const id = z.number().int().positive().max(2_147_483_647);
const body = z
  .object({
    imageId: id,
    /** The account whose report page showed the image. */
    userId: id,
    action: z.enum(SHOWN_ACTIONS),
    rendition: z.enum(SHOWN_RENDITIONS),
  })
  .strict();

/**
 * One image the CSAM report page put on screen and the moderator then opened or selected. The row is
 * the session moderator's, stamped by the database; the page names only the image and what it did.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  res.setHeader('cache-control', 'private, no-store');
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad request' });
  const { imageId, userId, action, rendition } = parsed.data;

  // The report page lists the subject's images and nothing else.
  const image = await dbRead.image.findFirst({
    where: { id: imageId, userId },
    select: { id: true },
  });
  if (!image) return void res.status(404).json({ error: 'Not on this page' });
  // A held image is shown only from storage, any other only from the CDN.
  const held = !!(await getHeldMedia(imageId));
  if ((rendition === 'original') !== held)
    return void res.status(409).json({ error: 'Not shown that way' });

  await trackModActivity(user.id, {
    entityType: 'image',
    entityId: imageId,
    activity: shownActivity(action, rendition),
  });
  res.status(204).end();
}

export default ModEndpoint(handler, ['POST']);
