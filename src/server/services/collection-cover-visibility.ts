import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';

/**
 * Whether an image may be shown as a collection's cover to someone who doesn't own it, as SQL over
 * `"Image" i` with `"Post" p` LEFT JOINed on `i."postId"`. The image must be scanned, not awaiting
 * review and not removed. A posted image needs its post published and not Private. A postless
 * image needs `postlessAllowed`: `coverUploadSql` for a collection's own cover, `itemUploadSql` for
 * a cover taken from an item.
 */
export function servableCollectionCoverSql({ postlessAllowed }: { postlessAllowed: Prisma.Sql }) {
  return Prisma.sql`(
    i."ingestion" = 'Scanned'
    AND i."needsReview" IS NULL
    AND i."blockedFor" IS NULL
    AND i."nsfwLevel" != ${NsfwLevel.Blocked}
    AND (
      (i."postId" IS NOT NULL AND p."publishedAt" < now() AND p."availability" != 'Private')
      OR (i."postId" IS NULL AND ${postlessAllowed})
    )
  )`;
}

/** A postless own cover: uploaded by the collection's owner or one of its managers. */
export function coverUploadSql({
  collectionId,
  collectionOwnerId,
}: {
  collectionId: Prisma.Sql;
  collectionOwnerId: Prisma.Sql;
}) {
  return Prisma.sql`(
    i."userId" = ${collectionOwnerId}
    OR EXISTS (
      SELECT 1 FROM "CollectionContributor" cc
      WHERE cc."collectionId" = ${collectionId}
        AND cc."userId" = i."userId"
        AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    )
  )`;
}

/**
 * A postless image taken from an item: only when the image's owner added the item. Anyone who can
 * add to a collection can name any image id, so who owns the collection proves nothing here.
 */
export function itemUploadSql(addedById: Prisma.Sql) {
  return Prisma.sql`i."userId" = ${addedById}`;
}

/** A published, scanned, non-private article, as SQL over `"Article" a`: its cover may come from an item. */
export const publishedArticleSql = Prisma.sql`(
  a.status = 'Published' AND a."publishedAt" IS NOT NULL AND a.availability != 'Private'
  AND a.ingestion = 'Scanned'
)`;

type CoverViewer = { id?: number; isModerator?: boolean } | undefined | null;

type CoverCandidate = { collectionId: number; collectionOwnerId: number; imageId: number };

type CoverDb = Pick<typeof dbRead, '$queryRaw'>;

/**
 * The collection ids whose cover may be shown to `viewer`. Staff and the image's owner see any
 * cover; everyone else gets `servableCollectionCoverSql`. Decided on the image id the caller read,
 * so a cover changed since then can't be judged on the old one. Pass the client the cover was read
 * from, so the image is judged as of that read.
 */
export async function getServableCoverCollectionIds(
  candidates: CoverCandidate[],
  viewer?: CoverViewer,
  db: CoverDb = dbRead
): Promise<Set<number>> {
  if (candidates.length === 0) return new Set();
  if (viewer?.isModerator) return new Set(candidates.map((c) => c.collectionId));

  const ownImage = viewer?.id ? Prisma.sql`i."userId" = ${viewer.id} OR ` : Prisma.empty;
  const rows = await db.$queryRaw<{ collectionId: number }[]>`
    SELECT v."collectionId"
    FROM unnest(
      ${candidates.map((c) => c.collectionId)}::int[],
      ${candidates.map((c) => c.collectionOwnerId)}::int[],
      ${candidates.map((c) => c.imageId)}::int[]
    ) AS v("collectionId", "collectionOwnerId", "imageId")
    JOIN "Image" i ON i.id = v."imageId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${ownImage}${servableCollectionCoverSql({
    postlessAllowed: coverUploadSql({
      collectionId: Prisma.sql`v."collectionId"`,
      collectionOwnerId: Prisma.sql`v."collectionOwnerId"`,
    }),
  })}
  `;
  return new Set(rows.map((r) => r.collectionId));
}

/**
 * `rows` with `image` set to null where `viewer` may not see the cover. Rows keep their order and
 * every other field; the stored cover is left as it is.
 */
export async function withServableCovers<
  T extends { id: number; userId: number; image?: { id: number } | null }
>(rows: T[], viewer?: CoverViewer): Promise<T[]> {
  const servable = await getServableCoverCollectionIds(
    rows.flatMap((row) =>
      row.image
        ? [{ collectionId: row.id, collectionOwnerId: row.userId, imageId: row.image.id }]
        : []
    ),
    viewer
  );
  return rows.map((row) =>
    row.image && !servable.has(row.id) ? ({ ...row, image: null } as T) : row
  );
}
