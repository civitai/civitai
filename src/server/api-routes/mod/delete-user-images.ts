import { deletePostRows } from '@civitai/db-queries/content-deletion';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { fromPrismaSql } from '~/server/db/prisma-sql-kysely';
import {
  FEEDBACK_CAPTURE_OWNER_REFUSAL,
  isFeedbackCaptureOwner,
} from '@civitai/shared/feedback-capture';
import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { deleteImages } from '~/server/services/image.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';
import { postHoldsHeldTextSql } from '~/server/services/post-text-hold';

const schema = z.object({
  userId: z.coerce.number(),
  batchSize: z.coerce.number().int().min(1).default(100),
});

export default ModEndpoint(
  async function deleteUserImages(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { userId, batchSize } = schema.parse(req.query);
      if (isFeedbackCaptureOwner(userId))
        return res.status(400).json({ error: FEEDBACK_CAPTURE_OWNER_REFUSAL });

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
        const result = await deleteImages(batch, {
          actor: { system: 'mod-delete-user-images' },
          moderatorDelete: true,
        });
        deletedImages += result.length;
      }

      let deletedPosts = 0;
      if (postIds.length) {
        // Only delete posts owned by the target user to avoid touching other users' posts
        // that may have referenced these images.
        const { deleted } = await deletePostRows(kyselyOver(dbWrite), {
          ids: postIds,
          actor: { system: 'mod-delete-user-images' },
          where: fromPrismaSql(
            Prisma.sql`"userId" = ${userId} AND NOT ${postHoldsHeldTextSql(
              Prisma.raw('"Post".id')
            )}`
          ),
        });
        deletedPosts = deleted.length;
      }

      return res.status(200).json({ deletedImages, deletedPosts });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
