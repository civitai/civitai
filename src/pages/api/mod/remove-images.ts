import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { chunk } from 'lodash-es';
import { Tracker } from '~/server/clickhouse/client';
import { reviewTypeToBlockedReasonKeys } from '~/server/services/image.service';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getResourceIdsForImages,
  getTagNamesForImages,
  moderateImages,
} from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';

const schema = z.object({
  imageIds: z.array(z.number()),
  userId: z.number().optional(),
  reason: z.enum(reviewTypeToBlockedReasonKeys).optional(),
});

// Process imageIds in chunks of 1000
const BATCH_SIZE = 1000;

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId, reason } = schema.parse(req.body);

    // Respond immediately with the total count
    res.status(200).json({
      images: imageIds.length,
    });

    const tracker = new Tracker(req, res);
    const imageIdChunks = chunk(imageIds, BATCH_SIZE);

    // Process each chunk
    for (const chunk of imageIdChunks) {
      // Get images data
      const images = await dbRead.image.findMany({
        where: { id: { in: chunk } },
        select: { nsfwLevel: true, userId: true, id: true },
      });

      // Get additional data for this chunk
      const imageTags = await getTagNamesForImages(chunk);
      const imageResources = await getResourceIdsForImages(chunk);

      // Moderate images for this chunk
      await moderateImages({
        ids: chunk,
        needsReview: undefined,
        reviewAction: 'delete',
        reviewType: 'blocked',
        userId,
      });

      // Track images for this chunk
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
