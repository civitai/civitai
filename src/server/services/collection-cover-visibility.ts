import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';

/** Scanned, not awaiting review, not removed: as SQL over `"Image" i`. */
const servableImageSql = Prisma.sql`(
  i."ingestion" = 'Scanned'
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i."nsfwLevel" != ${NsfwLevel.Blocked}
)`;

/**
 * Whether an image may be shown as a collection's cover to someone who doesn't own it, as SQL over
 * `"Image" i` with `"Post" p` LEFT JOINed on `i."postId"`. The image must be scanned, not awaiting
 * review and not removed. A posted image needs its post published and not Private. A postless
 * image needs `postlessAllowed`: `coverUploadSql` for a collection's own cover, `itemUploadSql` for
 * a cover taken from an item.
 */
export function servableCollectionCoverSql({ postlessAllowed }: { postlessAllowed: Prisma.Sql }) {
  return Prisma.sql`(
    ${servableImageSql}
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

/**
 * For each collection, a cover drawn from its first `itemsPerCollection` accepted items: one row
 * per item, `image` projected by `imageSql` over `"Image" i` (null when no item yields a servable
 * image) and `src` for an article's external cover.
 */
export function collectionItemCoversSql({
  collectionIds,
  itemsPerCollection,
  imageSql,
}: {
  collectionIds: number[];
  itemsPerCollection: number;
  imageSql: Prisma.Sql;
}) {
  return Prisma.sql`
    WITH target AS MATERIALIZED (
      SELECT *
      FROM (
        SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY ci."collectionId"
            ORDER BY ci.id
          ) AS idx
        FROM "CollectionItem" ci
        WHERE ci.status = 'ACCEPTED'
          AND ci."collectionId" IN (${Prisma.join(collectionIds)})
      ) t
      WHERE idx <= ${itemsPerCollection}
    ), imageItemImage AS MATERIALIZED (
      SELECT
        ti."collectionId",
        i.id,
        ${imageSql}
      FROM target ti
      JOIN "Image" i ON i.id = ti."imageId"
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE ${servableCollectionCoverSql({
        postlessAllowed: itemUploadSql(Prisma.sql`ti."addedById"`),
      })}
    ), postItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            i."postId" id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY i."postId" ORDER BY i.index) rn
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          WHERE i."postId" IN (SELECT "postId" FROM target WHERE "postId" IS NOT NULL)
            AND ${servableImageSql}
            AND p."publishedAt" < now()
            AND p."availability" != 'Private'
      ) t
      WHERE t.rn = 1
    ), modelItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            m.id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) rn
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
          JOIN "Model" m ON mv."modelId" = m.id AND m."userId" = p."userId"
          WHERE m."id" IN (SELECT "modelId" FROM target WHERE "modelId" IS NOT NULL)
              AND ${servableImageSql}
              AND p."publishedAt" < now()
              AND p."availability" != 'Private'
              AND m.status = 'Published'
              AND m."deletedAt" IS NULL
              AND m.availability != 'Private'
              AND m.mode IS DISTINCT FROM 'TakenDown'
              AND mv.status = 'Published'
              AND mv.availability != 'Private'
              AND (mv."publishedAt" IS NULL OR mv."publishedAt" <= now())
      ) t
      WHERE t.rn = 1
    ), articleItemImage AS MATERIALIZED (
        SELECT
          a.id,
          ${imageSql}
        FROM "Article" a
        JOIN "Image" i ON i.id = a."coverId"
        WHERE a.id IN (SELECT "articleId" FROM target WHERE "articleId" IS NOT NULL)
          AND ${servableImageSql}
          AND ${publishedArticleSql}
    ), articleItemSrc AS MATERIALIZED (
        SELECT a.id, a.cover src FROM "Article" a
        WHERE a.id IN (SELECT "articleId" FROM target WHERE "articleId" IS NOT NULL)
          AND ${publishedArticleSql}
    ), model3dItemImage AS MATERIALIZED (
        SELECT
          m3.id,
          ${imageSql}
        FROM "Model3D" m3
        JOIN "Image" i ON i.id = m3."thumbnailImageId"
        WHERE m3.id IN (SELECT "model3dId" FROM target WHERE "model3dId" IS NOT NULL)
          AND ${servableImageSql}
          AND m3.status = 'Published'
          AND m3."deletedAt" IS NULL
          AND m3.availability != 'Private'
    )
    SELECT
        target."collectionId" id,
        COALESCE(
          (SELECT image FROM imageItemImage iii WHERE iii.id = target."imageId" AND iii."collectionId" = target."collectionId" LIMIT 1),
          (SELECT image FROM postItemImage pii WHERE pii.id = target."postId"),
          (SELECT image FROM modelItemImage mii WHERE mii.id = target."modelId"),
          (SELECT image FROM articleItemImage aii WHERE aii.id = target."articleId"),
          (SELECT image FROM model3dItemImage m3i WHERE m3i.id = target."model3dId"),
          NULL
        ) image,
        (SELECT src FROM articleItemSrc ais WHERE ais.id = target."articleId") src
    FROM target
  `;
}

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
