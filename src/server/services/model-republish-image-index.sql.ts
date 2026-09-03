import { Prisma } from '@prisma/client';

/**
 * Bumps `Image."updatedAt"` for a republished model's own images, isolated from
 * `model.service` so a test can assert the emitted statement without importing
 * the service (which pulls the Prisma client, Axiom and the search index in at
 * module scope). Extracting the helper is the repo's preferred fix over a
 * shape-only assertion on an inline template. See
 * `__tests__/model-republish-image-index-sql.test.ts`.
 *
 * WHY THE STATEMENT EXISTS: `publishModelById` queues an image search-index
 * Update, but that enqueue fails open on a degraded sysRedis. The only recovery
 * for a dropped Update is each image index's delta scan, keyed on rows whose
 * `Image."updatedAt"` moved past the last watermark — and a republish otherwise
 * never touches the image rows, so a republished model's images keep the stale
 * `updatedAt` from the unpublish and no delta scan can re-derive them. Moving
 * `updatedAt` here is that missing anchor.
 *
 * Both predicates are load-bearing: `p."userId" = userId` scopes the bump to the
 * publisher's own images (the set the unpublish deleted from the index), and the
 * version-id list scopes it to this model. Widening either re-indexes images the
 * republish never affected. Set-based via `Post` so image ids stay out of the
 * bind list (65535-param limit); the version-id list is small.
 */
export function buildRepublishImageIndexTouch({
  userId,
  versionIds,
}: {
  userId: number;
  versionIds: number[];
}): Prisma.Sql {
  return Prisma.sql`
    UPDATE "Image" i
    SET "updatedAt" = NOW()
    FROM "Post" p
    WHERE i."postId" = p.id
      AND p."userId" = ${userId}
      AND p."modelVersionId" IN (${Prisma.join(versionIds, ',')})
  `;
}
