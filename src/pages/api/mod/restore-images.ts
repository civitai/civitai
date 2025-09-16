import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { chunk } from 'lodash-es';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { handleUnblockImages } from '~/server/services/image.service';
import { WebhookEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';

const schema = z.object({
  imageIds: z.array(z.number()),
  userId: z.number().optional(),
  batchSize: z.number().default(50), // Optional batch size for processing
  force: z.boolean().default(false), // Optional force to bypass tag checking
});

// after an image has been deleted, it can be restored which should remove blocking properties and update the nsfwLevel
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId, batchSize, force } = schema.parse(req.body);

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

    const imageIdsToUpdate = images.map((x) => x.id);
    if (imageIdsToUpdate.length === 0) {
      return res.status(200).json({ images: 0 });
    }

    const imageChunks = chunk(imageIdsToUpdate, batchSize); // Process images in chunks
    for (const chunkIds of imageChunks) {
      await handleUnblockImages({ ids: chunkIds });
    }

    const imageTags = await dbRead.$queryRaw<{ imageId: number; tag: string }[]>`
      SELECT "imageId", t."name" as "tag"
      FROM "TagsOnImageNew" toi
      JOIN "Tag" t ON toi."tagId" = t."id"
      WHERE toi."imageId" IN (${Prisma.join(imageIdsToUpdate)})
    `;

    const tracker = new Tracker(req, res);
    tracker.images(
      images.map((image) => {
        const tags = imageTags.filter((x) => x.imageId === image.id).map((x) => x.tag);
        return {
          type: 'Restore',
          imageId: image.id,
          ownerId: image.userId,
          nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
          userId,
          tags,
        };
      })
    );

    return res.status(200).json({
      images: images.length,
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
