import { Prisma } from '@prisma/client';
import { ImageConnectionType } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { isDefined } from '~/utils/type-guards';

export async function getImageConnectedEntities(imageIds: number[]) {
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { postId: true },
  });
  const connections = await dbRead.imageConnection.findMany({
    where: { imageId: { in: imageIds } },
    select: { entityType: true, entityId: true },
  });
  const articles = await dbRead.article.findMany({
    where: { coverId: { in: imageIds } },
    select: { id: true },
  });
  const collectionItems = await dbRead.collectionItem.findMany({
    where: { imageId: { in: imageIds } },
    select: { collectionId: true },
  });

  return {
    postIds: images.map((x) => x.postId).filter(isDefined),
    articleIds: articles.map((x) => x.id),
    bountyIds: connections
      .filter((x) => x.entityType === ImageConnectionType.Bounty)
      .map((x) => x.entityId),
    bountyEntryIds: connections
      .filter((x) => x.entityType === ImageConnectionType.BountyEntry)
      .map((x) => x.entityId),
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

export async function getPostConnectedEntities(postIds: number[]) {
  const posts = await dbRead.post.findMany({
    where: { id: { in: postIds } },
    select: { modelVersionId: true },
  });
  const collectionItems = await dbRead.collectionItem.findMany({
    where: { postId: { in: postIds } },
    select: { collectionId: true },
  });

  return {
    modelVersionIds: posts.map((x) => x.modelVersionId).filter(isDefined),
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

export async function updatePostNsfwLevels(postIds: number[]) {
  const posts = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p.id = ANY(ARRAY[${postIds}]::Int[])
      GROUP BY p.id
    )
    UPDATE "Post" p
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = p.id AND level."nsfwLevel" != p."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateArticleNsfwLevels(articleIds: number[]) {
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON (a.id) a.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Article" a
      JOIN "Image" i ON a."coverId" = i.id
      WHERE a.id = ANY(ARRAY[${articleIds}]::Int[])
      GROUP BY a.id
    )
    UPDATE "Article" a
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = a.id AND level."nsfwLevel" != a."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateBountyNsfwLevels(bountyIds: number[]) {
  // TODO.nsfwLevel - if bounty.nsfw then set bounty.NsfwLevel to NsfwLevel.XXX
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON ("entityId")
        "entityId",
        bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "ImageConnection" ic
      JOIN "Image" i ON i.id = ic."imageId"
      JOIN "Bounty" b on b.id = ic."entityId" AND ic."entityType" = 'Bounty'
      WHERE ic."entityType" = 'Bounty' AND ic."entityId" = ANY(ARRAY[${bountyIds}]::Int[])
      GROUP BY 1
    )
    UPDATE "Bounty" b SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateBountyEntryNsfwLevels(bountyEntryIds: number[]) {
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON ("entityId")
        "entityId",
        bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "ImageConnection" ic
      JOIN "Image" i ON i.id = ic."imageId"
      JOIN "BountyEntry" b on b.id = "entityId" AND ic."entityType" = 'BountyEntry'
      WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" = ANY(ARRAY[${bountyEntryIds}]::Int[])
      GROUP BY 1
    )
    UPDATE "BountyEntry" b SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateCollectionsNsfwLevels(collectionIds: number[]) {
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    UPDATE "Collection" c
    SET "nsfwLevel" = (
      SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel",0)), 0)
      FROM "CollectionItem" ci
      LEFT JOIN "Image" i on i.id = ci."imageId" AND c.type = 'Image'
      LEFT JOIN "Post" p on p.id = ci."postId" AND c.type = 'Post'
      LEFT JOIN "Model" m on m.id = ci."modelId" AND c.type = 'Model'
      LEFT JOIN "Article" a on a.id = ci."articleId" AND c.type = 'Article'
      WHERE ci."collectionId" = c.id
    )
    WHERE c.id = ANY(ARRAY[${collectionIds}]::Int[]) AND level."nsfwLevel" != c."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateModelNsfwLevels(modelIds: number[]) {
  // TODO.nsfwLevel - if model.nsfw then set model.NsfwLevel to NsfwLevel.XXX
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON ("modelId")
        mv."modelId" as "id",
        bit_or(mv."nsfwLevel") "nsfwLevel"
      FROM "ModelVersion" mv
      JOIN "Model" m on m.id = mv."modelId"
      WHERE m.id = ANY(ARRAY[${modelIds}]::Int[])
      GROUP BY mv.id
    )
    UPDATE "Model" m
    SET
      "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel"
    RETURNING id;
  `);
}

export async function updateModelVersionNsfwLevels(modelVersionIds: number[]) {
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level as (
      SELECT
        mv.id,
        (
          SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
          FROM (
            SELECT
              i."nsfwLevel"
            FROM "Post" p
            JOIN "Image" i ON i."postId" = p.id
            WHERE p."modelVersionId" = mv.id
            AND p."userId" = m."userId"
            AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
            ORDER BY p."id", i."index"
            LIMIT 20
          ) AS i
        ) AS "nsfwLevel"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv.id = ANY(ARRAY[${modelVersionIds}]::Int[])
    )
    UPDATE "ModelVersion" mv
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel"
    RETURNING id;
  `);
}
