import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  SERVED_ACTIVITY,
  SHOWN_ACTIONS,
  SHOWN_RENDITIONS,
  shownActivity,
} from '@civitai/shared/held-media';
import { dbWrite } from '~/server/db/client';
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

  // The report page lists the subject's images and nothing else. Both reads are on the primary: a
  // replica can lag a hold placed just before the page loaded.
  const image = await dbWrite.image.findFirst({
    where: { id: imageId, userId },
    select: { id: true },
  });
  if (!image) return void res.status(404).json({ error: 'Not on this page' });
  // A held image is shown only from storage, any other only from the CDN.
  const media = await getHeldMedia(imageId, dbWrite);
  if ((rendition === 'original') !== !!media)
    return void res.status(409).json({ error: 'Not shown that way' });

  const activity = shownActivity(action, rendition);
  if (rendition === 'cdn-450') {
    await trackModActivity(user.id, { entityType: 'image', entityId: imageId, activity });
    return void res.status(204).end();
  }
  // The original only as bytes this moderator was just served, in one statement with the serve read:
  // within 30 minutes, or 3 hours for a video (its type from the image row), which plays for longer.
  const recorded = await dbWrite.$executeRaw`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    SELECT ${user.id}::int, 'image', ${activity}::text, ${imageId}::int
    WHERE EXISTS (
      SELECT 1 FROM "ModActivity"
      WHERE activity = ${SERVED_ACTIVITY}::text AND "entityType" = 'image'
        AND "entityId" = ${imageId}::int AND "userId" = ${user.id}::int
        AND "createdAt" >= (now() AT TIME ZONE 'UTC') - CASE WHEN ${
          media?.type === 'video'
        }::boolean
          THEN interval '3 hours' ELSE interval '30 minutes' END
    )
    ON CONFLICT DO NOTHING
  `;
  if (!recorded) return void res.status(403).json({ error: 'Not served to you' });
  res.status(204).end();
}

export default ModEndpoint(handler, ['POST']);
