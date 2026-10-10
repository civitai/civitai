import type {
  ImageEntityType,
  ImageReferenceInput,
  GetEntitiesCoverImage,
  ImageMetaProps,
} from '~/server/schema/image.schema';
import { Prisma } from '@prisma/client';
import { ImageIngestionStatus, CosmeticEntity, type MediaType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  type GetImageConnectionRaw,
  getImageTagsForImages,
  createImageResources,
  type GetEntityImageRaw,
} from '~/server/services/image.service';
import type { VotableTagModel } from '~/libs/tags';
import { attachTagsToImages } from '~/server/services/image-detail.service';
import { pickClientImageColumns } from '~/server/utils/image-columns';
import { sanitizeProvenance } from '~/server/services/orchestrator/remix-provenance';
import { stripBlockProvenanceMetadata } from '~/shared/utils/block-provenance-metadata';
import { chunk, truncate } from 'lodash-es';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { EventViewer } from '~/server/events/event-access';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  getCosmeticsForEntity,
  getEventDecorationsForEntity,
} from '~/server/services/cosmetic.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { constants } from '~/server/common/constants';

export const getImagesByEntity = async ({
  id,
  ids,
  type,
  imagesPerId = 4,
  include,
  userId,
  isModerator,
}: {
  id?: number;
  ids?: number[];
  type: ImageEntityType;
  imagesPerId?: number;
  include?: ['tags'];
  userId?: number;
  isModerator?: boolean;
}) => {
  if (!id && (!ids || ids.length === 0)) {
    return [];
  }

  const AND: Prisma.Sql[] = !isModerator
    ? [
        Prisma.sql`(i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"${
          userId ? Prisma.sql` OR i."userId" = ${userId}` : Prisma.sql``
        })`,
      ]
    : [];

  if (!isModerator) {
    const needsReviewOr = [
      Prisma.sql`i."needsReview" IS NULL`,
      userId ? Prisma.sql`i."userId" = ${userId}` : null,
    ].filter(isDefined);

    if (needsReviewOr.length > 0) {
      AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);
    }
  }

  const images = await dbRead.$queryRaw<GetImageConnectionRaw[]>`
    WITH targets AS (
      SELECT
        id,
        "entityId"
      FROM (
        SELECT
          i.id,
          ic."entityId",
          row_number() OVER (PARTITION BY ic."entityId" ORDER BY i.index) row_num
        FROM "Image" i
        JOIN "ImageConnection" ic ON ic."imageId" = i.id
            AND ic."entityType" = ${type}
            AND ic."entityId" IN (${Prisma.join(ids ? ids : [id])})
        ${AND.length ? Prisma.sql`WHERE ${Prisma.join(AND, ' AND ')}` : Prisma.empty}
      ) ranked
      WHERE ranked.row_num <= ${imagesPerId}
    )
    SELECT
      i.id,
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      i."hideMeta",
      i."createdAt",
      i."mimeType",
      i.type,
      i.metadata,
      i.ingestion,
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."index",
      i.poi,
      i.minor,
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      t."entityId"
    FROM targets t
    JOIN "Image" i ON i.id = t.id`;

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    tagsVar = await getImageTagsForImages(imageIds);
  }

  return attachTagsToImages(images, tagsVar);
};

export const createEntityImages = async ({
  tx,
  entityId,
  entityType,
  images,
  userId,
}: {
  tx?: Prisma.TransactionClient;
  entityId?: number;
  entityType?: string;
  images: ImageReferenceInput[];
  userId: number;
}) => {
  const dbClient = tx ?? dbWrite;

  if (images.length === 0) {
    return [];
  }

  await dbClient.image.createMany({
    data: images.map((image) => ({
      ...pickClientImageColumns(image),
      // Same strip as `createImage`: nothing that reaches an Image row keeps a
      // provenance claim it didn't prove. These rows have no post, so they can't
      // reach a remix gallery today — but the invariant is "no unproven claim on
      // any row", not "on the rows that currently matter".
      meta:
        (sanitizeProvenance(image?.meta as Record<string, unknown> | null | undefined) as
          | Prisma.JsonObject
          | undefined) ?? Prisma.JsonNull,
      metadata: stripBlockProvenanceMetadata(image.metadata),
      userId,
      resources: undefined,
    })),
  });

  const imageRecords = await dbClient.image.findMany({
    select: { id: true, url: true, type: true, width: true, height: true },
    where: {
      url: { in: images.map((i) => i.url) },
      ingestion: ImageIngestionStatus.Pending,
      userId,
    },
  });

  const shouldAddImageResources = !!entityType && ['Bounty', 'BountyEntry'].includes(entityType);
  const batches = chunk(imageRecords, 50);
  for (const batch of batches) {
    if (shouldAddImageResources) {
      const tasks = batch.map((image) => () => createImageResources({ imageId: image.id, tx }));
      await limitConcurrency(tasks, 10);
    }
  }

  if (entityType && entityId) {
    await dbClient.imageConnection.createMany({
      data: imageRecords.map((image) => ({
        imageId: image.id,
        entityId,
        entityType,
      })),
    });
  }

  return imageRecords;
};

const isCosmeticEntity = (value: string): value is CosmeticEntity =>
  (Object.values(CosmeticEntity) as string[]).includes(value);

export const getEntityCoverImage = async ({
  entities,
  include,
  eventDecorationViewer,
}: GetEntitiesCoverImage & {
  include?: ['tags'];
  // Who sees event decorations before launch (see getEventDecorationsForEntity). Pass one only
  // where the result is never cached for someone else.
  eventDecorationViewer?: EventViewer;
}) => {
  if (entities.length === 0) {
    return [];
  }

  // Returns 1 cover image for:
  // Models, Images, Bounties, BountyEntries, Article and Post.
  const imagesRaw = await dbRead.$queryRaw<GetEntityImageRaw[]>`
    WITH entities AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
    )
    SELECT
      i.id,
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      i."hideMeta",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      i."createdAt",
      i."mimeType",
      i.type,
      i.metadata,
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."index",
      i."postId",
      t."entityId",
      t."entityType",
      i."poi",
      i."minor"
    FROM (
      -- NOTE: Adding "order1/2/3" looks a bit hacky, but it avoids using partitions and makes it far more performant.
      -- It might may look weird, but it has 0 practical effect other than better performance.
       SELECT
         *
        FROM
        (
          -- MODEL
          SELECT DISTINCT ON (e."entityId")
            e."entityId",
            e."entityType",
            i.id as "imageId",
            mv.index "order1",
            p.id "order2",
            i.index "order3"
          FROM entities e
          JOIN "Model" m ON e."entityId" = m.id
          JOIN "ModelVersion" mv ON m.id = mv."modelId"
          JOIN "Post" p ON mv.id = p."modelVersionId" AND p."userId" = m."userId"
          JOIN "Image" i ON p.id = i."postId"
          WHERE e."entityType" = 'Model'
          AND m.status = 'Published'
          AND i."ingestion" = 'Scanned'
          AND i."needsReview" IS NULL
          AND (
            (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
            OR NOT i."modelRestricted"
          )
          ORDER BY e."entityId", mv.index,  p.id, i.index
        ) t

        UNION

        -- MODEL VERSION
        SELECT * FROM (
          SELECT DISTINCT ON (e."entityId")
            e."entityId",
            e."entityType",
            i.id as "imageId",
            mv.index "order1",
            p.id "order2",
            i.index "order3"
          FROM entities e
          JOIN "ModelVersion" mv ON e."entityId" = mv."id"
          JOIN "Post" p ON mv.id = p."modelVersionId"
          JOIN "Image" i ON p.id = i."postId"
          WHERE e."entityType" = 'ModelVersion'
          AND mv.status = 'Published'
          AND i."ingestion" = 'Scanned'
          AND i."needsReview" IS NULL
          AND (
            (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
            OR NOT i."modelRestricted"
          )
          ORDER BY e."entityId", mv.index,  p.id, i.index
        ) t

        UNION
        -- IMAGES
        SELECT
            e."entityId",
            e."entityType",
            e."entityId" AS "imageId",
            0 "order1",
            0 "order2",
            0 "order3"
        FROM entities e
        WHERE e."entityType" = 'Image'

        UNION
        -- ARTICLES
        SELECT * FROM (
          SELECT DISTINCT ON (e."entityId")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              0 "order1",
	          0 "order2",
	          0 "order3"
          FROM entities e
          JOIN "Article" a ON a.id = e."entityId"
          JOIN "Image" i ON a."coverId" = i.id
          WHERE e."entityType" = 'Article'
          AND a."publishedAt" IS NOT NULL
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
        ) t

        UNION
        -- POSTS
        SELECT * FROM  (
          SELECT DISTINCT ON(e."entityId")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              i."postId" "order1",
	          i.index "order2",
	          0 "order3"
          FROM entities e
          JOIN "Post" p ON p.id = e."entityId"
          LEFT JOIN "ModelVersion" mv ON p."modelVersionId" = mv.id
          JOIN "Image" i ON i."postId" = p.id
          WHERE e."entityType" = 'Post'
            AND p."publishedAt" IS NOT NULL
            AND i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
            AND (
              (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
              OR NOT i."modelRestricted"
            )
          ORDER BY e."entityId", i."postId", i.index
        ) t

        UNION
        -- CONNECTIONS
        SELECT * FROM (
          -- There is one "ImageConnection" row per linked image, so this branch --
          -- alone among the six -- can emit many rows per entity (fan-out p50 1,
          -- p99 11, max 525). DISTINCT ON collapses it to the single row the JS
          -- join below would have consumed anyway, which is what keeps the size of
          -- this result set proportional to the number of entities requested.
          --
          -- The eligibility predicate belongs HERE rather than in the outer WHERE.
          -- DISTINCT ON picks its row before any later filter runs, so collapsing
          -- first and filtering afterwards could settle on an unscanned image and
          -- leave the entity with no cover at all, even though a sibling connection
          -- was eligible the whole time.
          --
          -- Both key columns are required. Every other branch pins a single
          -- "entityType", so "entityId" alone identifies a row there; this branch
          -- joins on the pair, so one id can legitimately recur across types.
          --
          -- "ImageConnection" carries no ordering column of its own -- no index, no
          -- timestamp -- so nothing on the link records which image the author meant
          -- to come first. The tiebreak is the image id, chosen for the properties
          -- that can actually be guaranteed: it is a primary key, so the order is
          -- total, never null, and leaves no residual tie for the planner to settle
          -- arbitrarily. It is deliberately NOT claimed to be a first-attached rule.
          -- "updateEntityImages" links already-existing images -- with arbitrary older
          -- ids -- ahead of the ones it creates in the same call, so attaching an older
          -- image on a later edit lowers the minimum and promotes that image to cover.
          -- What the tiebreak buys is a stable, deterministic choice, not a
          -- semantically-first one.
          SELECT DISTINCT ON (e."entityId", e."entityType")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              0 "order1",
              0 "order2",
              0 "order3"
          FROM entities e
          JOIN "ImageConnection" ic ON ic."entityId" = e."entityId" AND ic."entityType" = e."entityType"
          JOIN "Image" i ON i.id = ic."imageId"
          WHERE i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
          ORDER BY e."entityId", e."entityType", i.id
        ) t
    ) t
    JOIN "Image" i ON i.id = t."imageId"
    WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL`;

  // Index once instead of scanning `imagesRaw` per entity. `set` is guarded so the
  // first row for a key wins, matching what `.find()` returned: an entity can still
  // draw rows from two branches at once (an Article has both a cover image and
  // content-image connections), and this must not silently switch which one is kept.
  const imagesByEntity = new Map<string, GetEntityImageRaw>();
  for (const image of imagesRaw) {
    const key = `${image.entityId}:${image.entityType}`;
    if (!imagesByEntity.has(key)) imagesByEntity.set(key, image);
  }

  const images = entities
    .map((e) => imagesByEntity.get(`${e.entityId}:${e.entityType}`) ?? null)
    .filter(isDefined);

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    tagsVar = await getImageTagsForImages(imageIds);
  }

  const imageIds = images.map((i) => i.id);
  // The hat is the covered entity's own, as on that entity's feed card: a Model wears the
  // Model's hat, not whatever its cover image wears. An Image entity is its own cover.
  const decoratedIds = new Map<CosmeticEntity, number[]>();
  for (const { entityType, entityId } of images) {
    if (!isCosmeticEntity(entityType)) continue;
    decoratedIds.set(entityType, [...(decoratedIds.get(entityType) ?? []), entityId]);
  }
  const [cosmetics, eventDecorations] = await Promise.all([
    getCosmeticsForEntity({ ids: imageIds, entity: 'Image' }),
    Promise.all(
      [...decoratedIds].map(async ([entity, ids]) => ({
        entity,
        decorations: await getEventDecorationsForEntity({
          ids,
          entity,
          viewer: eventDecorationViewer,
        }),
      }))
    ),
  ]);
  const eventDecorationOf = (entityType: string, entityId: number) =>
    eventDecorations.find((x) => x.entity === entityType)?.decorations[entityId] ?? null;

  return attachTagsToImages(images, tagsVar).map((i) => ({
    ...i,
    cosmetic: cosmetics[i.id],
    eventDecoration: eventDecorationOf(i.entityType, i.entityId),
  }));
};

export const updateEntityImages = async ({
  tx,
  entityId,
  entityType,
  images,
  userId,
}: {
  tx?: Prisma.TransactionClient;
  entityId: number;
  entityType: string;
  images: ImageReferenceInput[];
  userId: number;
}) => {
  const dbClient = tx ?? dbWrite;
  const connections = await dbClient.imageConnection.findMany({
    select: { imageId: true },
    where: {
      entityId,
      entityType,
    },
  });

  // Delete any images that are no longer in the list.
  await dbClient.imageConnection.deleteMany({
    where: {
      entityId,
      entityType,
      imageId: { notIn: images.map((i) => i.id).filter(isDefined) },
    },
  });

  const newImages = images.filter((x) => !x.id);
  const newLinkedImages = images.filter(
    (x) => !!x.id && !connections.find((c) => c.imageId === x.id)
  );

  const linkIds = newLinkedImages.map((i) => i.id).filter(isDefined);
  if (linkIds.length > 0) {
    const owned = await dbClient.image.count({ where: { id: { in: linkIds }, userId } });
    if (owned !== new Set(linkIds).size) throw throwAuthorizationError();
  }

  const links = [...linkIds];
  let imageRecords: {
    id: number;
    url: string;
    type: MediaType;
    width: number | null;
    height: number | null;
  }[] = [];

  if (newImages.length > 0) {
    await dbClient.image.createMany({
      data: newImages.map((image) => ({
        ...pickClientImageColumns(image),
        meta:
          (sanitizeProvenance(image?.meta as Record<string, unknown> | null | undefined) as
            | Prisma.JsonObject
            | undefined) ?? Prisma.JsonNull,
        metadata: stripBlockProvenanceMetadata(image.metadata),
        userId,
        resources: undefined,
      })),
    });

    imageRecords = await dbClient.image.findMany({
      select: { id: true, url: true, type: true, width: true, height: true },
      where: {
        url: { in: newImages.map((i) => i.url) },
        ingestion: ImageIngestionStatus.Pending,
        userId,
      },
    });

    links.push(...imageRecords.map((i) => i.id));

    // Process the new images just in case:
    const shouldAddImageResources = !!entityType && ['Bounty', 'BountyEntry'].includes(entityType);
    const batches = chunk(imageRecords, 50);
    for (const batch of batches) {
      if (shouldAddImageResources) {
        await Promise.all(batch.map((image) => createImageResources({ imageId: image.id, tx })));
      }
    }
  }

  if (links.length > 0) {
    // Create any new files.
    await dbClient.imageConnection.createMany({
      data: links.filter(isDefined).map((id) => ({
        imageId: id,
        entityId,
        entityType,
      })),
    });
  }

  return imageRecords;
};

export async function get404Images() {
  const imagesRaw = await dbRead.$queryRaw<
    { url: string; username: string; meta: ImageMetaProps | null }[]
  >`
    SELECT
      u.username,
      i.url,
      i.meta
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId" AND username IS NOT NULL
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c."userId" = -1
      AND c.name = '404 Contest'
      AND i."ingestion" = 'Scanned'
      AND i."needsReview" IS NULL
      AND (i."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0
      AND ci.status = 'ACCEPTED';
  `;

  const images = Object.values(imagesRaw).map(({ meta, username, url }) => {
    const alt = truncate(meta?.prompt, { length: constants.altTruncateLength });
    return [username, url, alt];
  });

  return images;
}
