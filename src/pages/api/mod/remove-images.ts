import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
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
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds } = schema.parse(req.body);

    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: { nsfwLevel: true, userId: true, id: true },
    });

    // Get Additional Data
    const imageTags = await getTagNamesForImages(imageIds);
    const imageResources = await getResourceIdsForImages(imageIds);

    await moderateImages({
      ids: imageIds,
      needsReview: undefined,
      reviewAction: 'delete',
      reviewType: 'blocked',
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
      });
    }

    return res.status(200).json({
      images: imageIds.length,
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
