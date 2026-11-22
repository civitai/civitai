import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { chunk } from 'lodash-es';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { handleUnblockImages } from '~/server/services/image.service';
import { BlockedReason } from '~/server/common/enums';
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

    // primary: the replica can lag a CSAM block, and this split decides what is skipped.
    const found = await dbWrite.image.findMany({
      where: { id: { in: imageIds } },
      select: {
        nsfwLevel: true,
        userId: true,
        id: true,
        blockedFor: true,
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

    // Not restored here: a CSAM block is lifted only through the moderator CSAM review.
    const skipped = found.filter((x) => x.blockedFor === BlockedReason.CSAM).map((x) => x.id);
    const candidates = found.filter((x) => x.blockedFor !== BlockedReason.CSAM);
    if (candidates.length === 0) {
      return res.status(200).json({ images: 0, skipped });
    }

    // Counted and tracked only as the service restored them: it re-checks each image itself, and one
    // it kept blocked (its owner is deleted) is not restored.
    const restoredIds = new Set<number>();
    for (const chunkIds of chunk(
      candidates.map((x) => x.id),
      batchSize
    )) {
      const { restored } = await handleUnblockImages({ ids: chunkIds });
      for (const image of restored) restoredIds.add(image.id);
    }
    const images = candidates.filter((x) => restoredIds.has(x.id));
    if (images.length === 0) {
      return res.status(200).json({ images: 0, skipped });
    }
    const imageIdsToUpdate = images.map((x) => x.id);

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
      skipped,
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
