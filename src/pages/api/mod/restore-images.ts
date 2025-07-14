import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { moderateImages } from '~/server/services/image.service';
import { WebhookEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';

const schema = z.object({
  imageIds: z.array(z.number()),
  userId: z.number().optional(),
});

// after an image has been deleted, it can be restored which should remove blocking properties and update the nsfwLevel
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId } = schema.parse(req.body);

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
    const imageTags = await dbRead.$queryRaw<{ imageId: number; tag: string }[]>`
      SELECT "imageId", t."name" as "tag"
      FROM "TagsOnImageNew" toi
      JOIN "Tag" t ON toi."tagId" = t."id"
      WHERE toi."imageId" IN (${Prisma.join(imageIds)})
    `;

    await moderateImages({
      ids: imageIds,
      needsReview: null,
      reviewAction: undefined,
      reviewType: 'blocked',
      userId,
    });

    const tracker = new Tracker(req, res);
    for (const image of images) {
      const tags = imageTags.filter((x) => x.imageId === image.id).map((x) => x.tag);
      tracker.image({
        type: 'Restore',
        imageId: image.id,
        ownerId: image.userId,
        nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
        userId,
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
