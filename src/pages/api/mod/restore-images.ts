import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { moderateImages } from '~/server/services/image.service';
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
      select: {
        nsfwLevel: true,
        userId: true,
        id: true,
        tags: {
          select: {
            tag: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    await moderateImages({
      ids: imageIds,
      needsReview: null,
      reviewAction: undefined,
      reviewType: 'blocked',
    });

    const tracker = new Tracker(req, res);
    for (const image of images) {
      const tags = image.tags.map((x) => x.tag.name);
      tracker.image({
        type: 'Restore',
        imageId: image.id,
        ownerId: image.userId,
        nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
        tags,
      });
    }

    return res.status(200).json({
      images: imageIds.length,
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
