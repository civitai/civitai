import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { deleteImages } from '~/server/services/image.service';
import {
  accountHoldSql,
  assertAccountNotUnderLegalHold,
  LEGAL_HOLD_REFUSAL,
  LegalHoldError,
} from '~/server/services/legal-hold.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  batchSize: z.coerce.number().default(100),
});

export default ModEndpoint(
  async function deleteUserImages(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { userId, batchSize } = schema.parse(req.query);
      const { markerView } = await assertAccountNotUnderLegalHold(userId);
      // Repeated in each delete, so a hold that lands mid-run stops the rest.
      const unlessHeld = Prisma.sql`NOT ${accountHoldSql(Prisma.sql`${userId}::int`, markerView)}`;

      const images = await dbRead.image.findMany({
        where: { userId },
        select: { id: true, postId: true },
      });
      if (images.length === 0) return res.status(200).json({ deletedImages: 0, deletedPosts: 0 });

      const imageIds = images.map((i) => i.id);
      const postIds = [
        ...new Set(images.map((i) => i.postId).filter((id): id is number => id != null)),
      ];

      let deletedImages = 0;
      for (const batch of chunk(imageIds, batchSize)) {
        const result = await deleteImages(batch, true, { onlyWhere: unlessHeld });
        deletedImages += result.length;
      }

      let deletedPosts = 0;
      if (postIds.length) {
        // Only delete posts owned by the target user to avoid touching other users' posts
        // that may have referenced these images.
        deletedPosts = await dbWrite.$executeRaw`
          DELETE FROM "Post"
          WHERE "userId" = ${userId} AND id = ANY(${postIds}::int[]) AND ${unlessHeld}
        `;
      }

      return res.status(200).json({ deletedImages, deletedPosts });
    } catch (e) {
      if (e instanceof LegalHoldError) return res.status(403).json({ error: LEGAL_HOLD_REFUSAL });
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
