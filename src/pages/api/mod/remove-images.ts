import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { reviewTypeToBlockedReasonKeys } from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getResourceIdsForImages,
  getTagNamesForImages,
  moderateImages,
} from '~/server/services/image.service';
import { WebhookEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';

const schema = z.object({
  imageIds: z.array(z.number()),
  userId: z.number().optional(),
  reason: z.enum(reviewTypeToBlockedReasonKeys).optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId, reason } = schema.parse(req.body);

    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: { nsfwLevel: true, userId: true, id: true },
    });

    res.status(200).json({
      images: imageIds.length,
    });

    // Get Additional Data
    const imageTags = await getTagNamesForImages(imageIds);
    const imageResources = await getResourceIdsForImages(imageIds);

    await moderateImages({
      ids: imageIds,
      needsReview: undefined,
      reviewAction: 'delete',
      reviewType: 'blocked',
      userId,
    });

    const tracker = new Tracker(req, res);
    for (const image of images) {
      tracker.image({
        type: 'DeleteTOS',
        imageId: image.id,
        ownerId: image.userId,
        nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
        tags: imageTags[image.id] ?? [],
        resources: imageResources[image.id] ?? [],
        tosReason: reason,
      });
    }
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'mod-remove-images-error',
      error: err.message,
      cause: err.cause,
      stack: err.stack,
    });
  }
});
