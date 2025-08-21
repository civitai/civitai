import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getResourceIdsForImages,
  getTagNamesForImages,
  handleBlockImages,
} from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Limiter } from '~/server/utils/concurrency-helpers';

const schema = z.object({
  imageIds: z.array(z.number()),
  userId: z.number().optional(),
  reason: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId, reason } = schema.parse(req.body);

    // Respond immediately with the total count
    res.status(200).json({
      images: imageIds.length,
    });

    const tracker = new Tracker(req, res);
    const images = await handleBlockImages({ ids: imageIds, userId });
    await Limiter({ batchSize: 1000 }).process(images, async (images) => {
      const imageIds = images.map((x) => x.id);
      // Get additional data for this chunk
      const imageTags = await getTagNamesForImages(imageIds);
      const imageResources = await getResourceIdsForImages(imageIds);
      await tracker.images(
        images.map((image) => ({
          type: 'DeleteTOS',
          imageId: image.id,
          ownerId: image.userId,
          nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
          tags: imageTags[image.id] ?? [],
          resources: imageResources[image.id] ?? [],
          tosReason: reason,
        }))
      );
    });
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
