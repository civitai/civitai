import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import {
  imageNotRestrictedSql,
  minorMatureImageVisibleSql,
} from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import { heldGalleryImageSql } from '~/server/utils/held-gallery-level.sql';
import { isRatingWithinCap } from '~/shared/utils/rating-cap';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Scanned, rated, not awaiting review, not removed or a ToS violation, allowed by its base model:
 * as SQL over `"Image" i`.
 */
const servableImageSql = Prisma.sql`(
  i."ingestion" = 'Scanned'
  AND i."nsfwLevel" != 0
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i."tosViolation" IS NOT TRUE
  AND i."nsfwLevel" != ${NsfwLevel.Blocked}
  AND ${imageNotRestrictedSql()}
  AND ${minorMatureImageVisibleSql()}
)`;

/** The post `"Post" p` is on no taken-down model; true for no post or a post on no model. */
const notOnTakenDownModelSql = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
  WHERE mv.id = p."modelVersionId" AND m.mode = 'TakenDown'
)`;

/**
 * The image `"Image" i` on post `"Post" p` is within its model's gallery level when the model is
 * minor or SFW-only; true for no post or a post on no model. `exempt` is over that model `hm`: who
 * sees its whole showcase. A cover is shared between viewers unless the caller says otherwise.
 */
function withinHeldGallerySql(exempt: Prisma.Sql = Prisma.sql`FALSE`) {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "ModelVersion" hmv
    JOIN "Model" hm ON hm.id = hmv."modelId"
    WHERE hmv.id = p."modelVersionId"
      AND NOT ${heldGalleryImageSql({ model: Prisma.raw('hm'), exempt })}
  )`;
}

/**
 * The image `"Image" i` on post `"Post" p` is allowed by its model, for every viewer: on no
 * taken-down model, and within a minor or SFW-only model's gallery level. True for no post or a post
 * on no model.
 */
const withinItsModelSql = Prisma.sql`(${notOnTakenDownModelSql} AND ${withinHeldGallerySql()})`;

/** `withinItsModelSql` for the image with id `imageId`; true when that image is on no post. */
export function imageAllowedByItsModelSql(imageId: Prisma.Sql) {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId} AND NOT ${withinItsModelSql}
  )`;
}

/**
 * Whether an image may be shown as a collection's cover to someone who doesn't own it, as SQL over
 * `"Image" i` with `"Post" p` LEFT JOINed on `i."postId"`. The image must be scanned, not awaiting
 * review and not removed. A posted image needs its post published, not Private and on no
 * taken-down model, and within the gallery level of a minor or SFW-only model. A postless image
 * needs `postlessAllowed`: `coverUploadSql` for a collection's own cover, `itemUploadSql` for a
 * cover taken from an item. `heldExempt` (over the model `hm`) is who sees past the gallery level.
 */
export function servableCollectionCoverSql({
  postlessAllowed,
  heldExempt,
}: {
  postlessAllowed: Prisma.Sql;
  heldExempt?: Prisma.Sql;
}) {
  return Prisma.sql`(
    ${servableImageSql}
    AND (
      (
        i."postId" IS NOT NULL
        AND p."publishedAt" < now()
        AND p."availability" != 'Private'
        AND ${notOnTakenDownModelSql}
        AND ${withinHeldGallerySql(heldExempt)}
      )
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

/** A published, non-private post, as SQL over `"Post" p`. */
export const publishedPostSql = Prisma.sql`(p."publishedAt" < now() AND p."availability" != 'Private')`;

/**
 * A published, non-private model that is not deleted or taken down, as SQL over `"Model" m`.
 * As the add-to-collection gate, stricter than view (getModelIdsVisibleToViewer) for non-owners,
 * which lets them see Private and taken-down models: collection items are shown to everyone who
 * sees the collection. Owners may add their own.
 */
export const publishedModelSql = Prisma.sql`(
  m.status = 'Published' AND m."deletedAt" IS NULL AND m.availability != 'Private'
  AND m.mode IS DISTINCT FROM 'TakenDown'
)`;

/**
 * A published, non-private 3D model that is not deleted, as SQL over `"Model3D" m3`. As the add
 * gate, stricter than view (canViewModel3d, which ignores availability) for non-owners, for the
 * reason given on publishedModelSql. Owners may add their own.
 */
export const publishedModel3dSql = Prisma.sql`(
  m3.status = 'Published' AND m3."deletedAt" IS NULL AND m3.availability != 'Private'
)`;

/**
 * Whether article `"Article" a`'s legacy cover string may be served: beside a servable cover or
 * banner image within `imageLevels` and its model's gallery level, on no taken-down model, or, with
 * neither, for an article at an SFW level.
 */
export function legacyCoverStringAllowedSql(imageLevels: number = sfwBrowsingLevelsFlag) {
  return Prisma.sql`CASE
    WHEN a."coverId" IS NULL AND a."bannerId" IS NULL THEN
      (a."nsfwLevel" & ${sfwBrowsingLevelsFlag}::int) <> 0
      AND (a."nsfwLevel" & ~${sfwBrowsingLevelsFlag}::int) = 0
    ELSE EXISTS (
      SELECT 1 FROM "Image" i
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE i.id = COALESCE(a."coverId", a."bannerId")
        AND ${servableImageSql}
        AND ${withinItsModelSql}
        AND (i."nsfwLevel" & ${imageLevels}::int) <> 0
        AND (i."nsfwLevel" & ~${imageLevels}::int) = 0
    )
  END`;
}

/**
 * For each collection, a cover drawn from its first `itemsPerCollection` accepted items: one row
 * per item, `image` projected by `imageSql` over `"Image" i` (null when no item yields a servable
 * image) and `src` for an article's external cover.
 */
export function collectionItemCoversSql({
  collectionIds,
  itemsPerCollection,
  imageSql,
  srcImageLevels = sfwBrowsingLevelsFlag,
}: {
  collectionIds: number[];
  itemsPerCollection: number;
  imageSql: Prisma.Sql;
  /**
   * The levels an article's cover image may have for its legacy cover string to go with it. SFW
   * for a reader that shows the string to everyone; a reader that drops the string with an image
   * above the viewer's level may pass every level.
   */
  srcImageLevels?: number;
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
            AND ${publishedPostSql}
            AND ${withinItsModelSql}
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
              AND ${publishedPostSql}
              AND ${publishedModelSql}
              AND ${heldGalleryImageSql()}
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
        JOIN "Image" i ON i.id = COALESCE(a."coverId", a."bannerId")
        LEFT JOIN "Post" p ON p.id = i."postId"
        WHERE a.id IN (SELECT "articleId" FROM target WHERE "articleId" IS NOT NULL)
          AND ${servableImageSql}
          AND ${withinItsModelSql}
          AND ${publishedArticleSql}
    ), articleItemSrc AS MATERIALIZED (
        -- A legacy cover string carries no rating of its own, and its readers show it to every
        -- viewer: it goes with a servable cover or banner image at a level everyone may see, or,
        -- with neither, an article at such a level. An image that cannot be served drops it.
        SELECT a.id, a.cover src FROM "Article" a
        WHERE a.id IN (SELECT "articleId" FROM target WHERE "articleId" IS NOT NULL)
          AND ${publishedArticleSql}
          AND ${legacyCoverStringAllowedSql(srcImageLevels)}
    ), model3dItemImage AS MATERIALIZED (
        SELECT
          m3.id,
          ${imageSql}
        FROM "Model3D" m3
        JOIN "Image" i ON i.id = m3."thumbnailImageId"
        WHERE m3.id IN (SELECT "model3dId" FROM target WHERE "model3dId" IS NOT NULL)
          AND ${servableImageSql}
          AND ${publishedModel3dSql}
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

/**
 * Of these image ids, the ones their model withholds (taken down, or above a minor or SFW-only
 * model's gallery level): the rule `imageAllowedByItsModelSql` applies. No viewer exemption here;
 * callers exempt moderators and owners.
 */
export async function getModelWithheldImageIds(
  imageIds: number[],
  db: Pick<typeof dbRead, '$queryRaw'> = dbRead
): Promise<Set<number>> {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return new Set();
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id IN (${Prisma.join(ids)}) AND NOT ${withinItsModelSql}
  `;
  return new Set(rows.map((row) => Number(row.id)));
}

type CoverViewer = { id?: number; isModerator?: boolean } | undefined | null;

type CoverCandidate = { collectionId: number; collectionOwnerId: number; imageId: number };

type CoverDb = Pick<typeof dbRead, '$queryRaw'>;

/**
 * The collection ids whose cover may be shown to `viewer`. Moderators see any cover except a
 * restricted image someone else uploaded; the image's owner sees their own past every rule except
 * the gallery level of a minor or SFW-only model they don't own; everyone else gets
 * `servableCollectionCoverSql`. Decided on the image id the caller read,
 * so a cover changed since then can't be judged on the old one. Pass the client the cover was read
 * from, so the image is judged as of that read.
 */
export async function getServableCoverCollectionIds(
  candidates: CoverCandidate[],
  viewer?: CoverViewer,
  db: CoverDb = dbRead
): Promise<Set<number>> {
  if (candidates.length === 0) return new Set();

  const ownImage = viewer?.id ? Prisma.sql`i."userId" = ${viewer.id} OR ` : Prisma.empty;
  // The image's owner sees their own past the rules above, but not past the gallery level of a
  // model they don't own: that is the model owner's alone.
  const modelOwnerSql = viewer?.id ? Prisma.sql`hm."userId" = ${viewer.id}` : Prisma.sql`FALSE`;
  const servable = viewer?.isModerator
    ? Prisma.sql`TRUE`
    : Prisma.sql`(${ownImage}${servableCollectionCoverSql({
        postlessAllowed: coverUploadSql({
          collectionId: Prisma.sql`v."collectionId"`,
          collectionOwnerId: Prisma.sql`v."collectionOwnerId"`,
        }),
        heldExempt: modelOwnerSql,
      })}) AND ${withinHeldGallerySql(modelOwnerSql)}`;
  const rows = await db.$queryRaw<{ collectionId: number }[]>`
    SELECT v."collectionId"
    FROM unnest(
      ${candidates.map((c) => c.collectionId)}::int[],
      ${candidates.map((c) => c.collectionOwnerId)}::int[],
      ${candidates.map((c) => c.imageId)}::int[]
    ) AS v("collectionId", "collectionOwnerId", "imageId")
    JOIN "Image" i ON i.id = v."imageId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${servable}
      AND ${imageNotRestrictedSql({ viewerId: viewer?.id })}
  `;
  return new Set(rows.map((r) => r.collectionId));
}

/**
 * Whether a cover may be served at `browsingLevel`: rated within it, and never Blocked or a ToS
 * violation, whatever the level. Narrower than `isPublicCoverImage`, the public API's rule: the
 * app shows its viewers images that rule refuses (POI, minor), and its covers carry only these
 * fields. Servability is judged in SQL first (`servableCollectionCoverSql`).
 */
export function isCoverWithinBrowsingLevel(
  image: { nsfwLevel?: number | null; tosViolation?: boolean | null },
  browsingLevel: number
) {
  return (
    !image.tosViolation &&
    image.nsfwLevel !== NsfwLevel.Blocked &&
    isRatingWithinCap(image.nsfwLevel, browsingLevel)
  );
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
