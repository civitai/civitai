import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { deleteImages } from '~/server/services/image.service';
import { detachHeldThreadsCte } from '~/server/services/comment-thread-hold';
import {
  accountHoldSql,
  assertAccountNotUnderLegalHold,
  isLegalHoldAbort,
  LEGAL_HOLD_STOPPED,
  LegalHoldError,
  LegalHoldStoppedError,
  legalHoldMessage,
} from '~/server/services/legal-hold.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  batchSize: z.coerce.number().int().min(1).default(100),
});

export default ModEndpoint(
  async function deleteUserImages(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { userId, batchSize } = schema.parse(req.query);
      const { markerView } = await assertAccountNotUnderLegalHold(userId);
      // Repeated in each delete, so a hold that lands mid-run stops the rest.
      const held = accountHoldSql(Prisma.sql`${userId}::int`, markerView);
      const unlessHeld = Prisma.sql`NOT ${held}`;

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
          WITH doomed AS (
            SELECT id FROM "Post"
            WHERE "userId" = ${userId} AND id = ANY(${postIds}::int[]) AND ${unlessHeld}
          ),
          ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT id FROM doomed` }, markerView)}
          DELETE FROM "Post" WHERE id IN (SELECT id FROM doomed)
        `;
      }

      // A hold that landed mid-run stopped the deletes above without an error.
      const [after] = await dbWrite.$queryRaw<{ held: unknown }[]>`SELECT ${held} AS held`;
      if (after?.held !== false) throw new LegalHoldStoppedError();

      return res.status(200).json({ deletedImages, deletedPosts });
    } catch (e) {
      if (e instanceof LegalHoldStoppedError || isLegalHoldAbort(e))
        return handleEndpointError(
          res,
          new TRPCError({ code: 'CONFLICT', message: LEGAL_HOLD_STOPPED })
        );
      if (e instanceof LegalHoldError)
        return handleEndpointError(
          res,
          new TRPCError({ code: 'FORBIDDEN', message: legalHoldMessage(e) })
        );
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
