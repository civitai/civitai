import { Prisma } from '@prisma/client';
import { chunk, uniq } from 'lodash-es';
import { ImageConnectionType, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

async function getImageConnectedEntities(imageIds: number[]) {
  // these dbReads could be run concurrently
  const [images, connections, articles, collectionItems] = await Promise.all([
    dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: { postId: true },
    }),
    dbRead.imageConnection.findMany({
      where: { imageId: { in: imageIds } },
      select: { entityType: true, entityId: true },
    }),
    dbRead.article.findMany({
      where: { coverId: { in: imageIds } },
      select: { id: true },
    }),
    dbRead.collectionItem.findMany({
      where: { imageId: { in: imageIds }, status: CollectionItemStatus.ACCEPTED },
      select: { collectionId: true },
    }),
  ]);

  const comicPanels = await dbRead.comicPanel.findMany({
    where: { imageId: { in: imageIds } },
    select: { projectId: true },
  });

  return {
    postIds: images.map((x) => x.postId).filter(isDefined),
    articleIds: [
      ...new Set([
        ...articles.map((x) => x.id),
        ...connections
          .filter((x) => x.entityType === ImageConnectionType.Article)
          .map((x) => x.entityId),
      ]),
    ],
    bountyIds: connections
      .filter((x) => x.entityType === ImageConnectionType.Bounty)
      .map((x) => x.entityId),
    bountyEntryIds: connections
      .filter((x) => x.entityType === ImageConnectionType.BountyEntry)
      .map((x) => x.entityId),
    comicProjectIds: comicPanels.map((x) => x.projectId),
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

async function getPostConnectedEntities(postIds: number[]) {
  const [posts, collectionItems] = await Promise.all([
    dbRead.post.findMany({
      where: { id: { in: postIds } },
      select: { modelVersionId: true },
    }),
    dbRead.collectionItem.findMany({
      where: { postId: { in: postIds }, status: CollectionItemStatus.ACCEPTED },
      select: { collectionId: true },
    }),
  ]);

  return {
    modelVersionIds: posts.map((x) => x.modelVersionId).filter(isDefined),
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

async function getModelVersionConnectedEntities(modelVersionIds: number[]) {
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: { modelId: true },
  });

  return {
    modelIds: modelVersions.map((x) => x.modelId),
  };
}

async function getModelConnectedEntities(modelIds: number[]) {
  const collectionItems = await dbRead.collectionItem.findMany({
    where: { modelId: { in: modelIds }, status: CollectionItemStatus.ACCEPTED },
    select: { collectionId: true },
  });

  return {
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

async function getArticleConnectedEntities(articleIds: number[]) {
  const collectionItems = await dbRead.collectionItem.findMany({
    where: { articleId: { in: articleIds }, status: CollectionItemStatus.ACCEPTED },
    select: { collectionId: true },
  });

  return {
    collectionIds: collectionItems.map((x) => x.collectionId),
  };
}

export async function getNsfwLevelRelatedEntities(source: {
  imageIds?: number[];
  postIds?: number[];
  articleIds?: number[];
  bountyIds?: number[];
  bountyEntryIds?: number[];
  collectionIds?: number[];
  modelIds?: number[];
  modelVersionIds?: number[];
  comicProjectIds?: number[];
}) {
  let postIds: number[] = [];
  let articleIds: number[] = [];
  let bountyIds: number[] = [];
  let bountyEntryIds: number[] = [];
  let collectionIds: number[] = [];
  let modelIds: number[] = [];
  let modelVersionIds: number[] = [];
  let comicProjectIds: number[] = [];

  function mergeRelated(
    data: Partial<{
      postIds: number[];
      articleIds: number[];
      bountyIds: number[];
      bountyEntryIds: number[];
      collectionIds: number[];
      modelIds: number[];
      modelVersionIds: number[];
      comicProjectIds: number[];
    }>
  ) {
    if (data.postIds) postIds = uniq(postIds.concat(data.postIds));
    if (data.articleIds) articleIds = uniq(articleIds.concat(data.articleIds));
    if (data.bountyIds) bountyIds = uniq(bountyIds.concat(data.bountyIds));
    if (data.bountyEntryIds) bountyEntryIds = uniq(bountyEntryIds.concat(data.bountyEntryIds));
    if (data.collectionIds) collectionIds = uniq(collectionIds.concat(data.collectionIds));
    if (data.modelIds) modelIds = uniq(modelIds.concat(data.modelIds));
    if (data.modelVersionIds) modelVersionIds = uniq(modelVersionIds.concat(data.modelVersionIds));
    if (data.comicProjectIds) comicProjectIds = uniq(comicProjectIds.concat(data.comicProjectIds));
  }

  if (source.imageIds?.length) {
    const imageRelations = await getImageConnectedEntities(source.imageIds);
    mergeRelated(imageRelations);
  }

  if (source.postIds?.length || postIds.length) {
    const postRelations = await getPostConnectedEntities([...(source.postIds ?? []), ...postIds]);
    mergeRelated(postRelations);
  }

  if (source.articleIds?.length || articleIds.length) {
    const articleRelations = await getArticleConnectedEntities([
      ...(source.articleIds ?? []),
      ...articleIds,
    ]);
    mergeRelated(articleRelations);
  }

  if (source.modelVersionIds?.length || modelVersionIds.length) {
    const modelVersionRelations = await getModelVersionConnectedEntities([
      ...(source.modelVersionIds ?? []),
      ...modelVersionIds,
    ]);
    mergeRelated(modelVersionRelations);
  }

  if (source.modelIds?.length || modelIds.length) {
    const modelRelations = await getModelConnectedEntities([
      ...(source.modelIds ?? []),
      ...modelIds,
    ]);
    mergeRelated(modelRelations);
  }

  return {
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    collectionIds,
    modelIds,
    modelVersionIds,
    comicProjectIds: uniq([...(source.comicProjectIds ?? []), ...comicProjectIds]),
  };
}

const batchSize = 1000;
function batcher(ids: number[], fn: (ids: number[]) => Promise<void>) {
  return chunk(ids, batchSize).map((chunk) => async () => {
    try {
      if (chunk.length > 0) {
        // console.log('processing chunk', chunk.length, fn.name);
        await fn(chunk);
      }
    } catch (e: any) {
      logToAxiom({ type: 'error', name: 'update-nsfw-levels-batcher', message: e.message });
      console.log('processing chunk', chunk.length, fn.name);
    }
  });
}

export async function updateNsfwLevels({
  postIds,
  articleIds,
  bountyIds,
  bountyEntryIds,
  collectionIds,
  modelIds,
  modelVersionIds,
  comicProjectIds = [],
}: {
  postIds: number[];
  articleIds: number[];
  bountyIds: number[];
  bountyEntryIds: number[];
  collectionIds: number[];
  modelIds: number[];
  modelVersionIds: number[];
  comicProjectIds?: number[];
}) {
  const updatePosts = batcher(postIds, updatePostNsfwLevels);
  const updateArticles = batcher(articleIds, updateArticleNsfwLevels);
  const updateBounties = batcher(bountyIds, updateBountyNsfwLevels);
  const updateBountyEntries = batcher(bountyEntryIds, updateBountyEntryNsfwLevels);
  const updateModelVersions = batcher(modelVersionIds, updateModelVersionNsfwLevels);
  const updateModels = batcher(modelIds, updateModelNsfwLevels);
  const updateComicChapters = batcher(comicProjectIds, updateComicChapterNsfwLevels);
  const updateComicProjects = batcher(comicProjectIds, updateComicProjectNsfwLevels);
  // Collections are processed by separate optimized job
  // const updateCollections = batcher(collectionIds, updateCollectionsNsfwLevels);

  const nsfwLevelChangeBatches = [
    [updatePosts, updateArticles, updateBounties, updateBountyEntries, updateComicChapters],
    [updateModelVersions, updateComicProjects],
    [updateModels],
    // Collections handled by dedicated job for performance
    // [updateCollections],
  ];

  for (const batch of nsfwLevelChangeBatches) {
    const tasks = batch.flat();
    await limitConcurrency(tasks, 5);
  }
}

export async function updatePostNsfwLevels(postIds: number[]) {
  if (!postIds.length) return;
  await dbWrite.$queryRaw(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p.id IN (${Prisma.join(postIds)})
      GROUP BY p.id
    )
    UPDATE "Post" p
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = p.id AND level."nsfwLevel" != p."nsfwLevel";
  `);
}

export async function updateArticleNsfwLevels(articleIds: number[]) {
  if (!articleIds.length) return;
  const articles = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
      WITH level AS (
        SELECT
          a.id,
          GREATEST(
            -- Cover is a single row per article, so max() is effectively identity.
            COALESCE(max(cover."nsfwLevel"), 0),
            -- Content images can be many-per-article. Take the highest rating
            -- rather than bit_or'ing them: image nsfwLevel values are powers of
            -- 2 (PG=1, PG13=2, R=4, X=8, XXX=16), so integer max == highest
            -- rating. bit_or would produce multi-bit masks that leak through
            -- the downstream (nsfwLevel & browsingLevel) != 0 filter when an
            -- article mixes PG + NSFW images.
            COALESCE(max(content_imgs."nsfwLevel"), 0)
          ) AS "nsfwLevel"
        FROM "Article" a

        -- Cover image (left join - may not exist)
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id
          AND cover."ingestion" = 'Scanned'

        -- Content images (left join - may not exist)
        LEFT JOIN "ImageConnection" ic
          ON ic."entityId" = a.id
          AND ic."entityType" = 'Article'
        LEFT JOIN "Image" content_imgs
          ON ic."imageId" = content_imgs.id
          AND content_imgs."ingestion" = 'Scanned'

        WHERE a.id IN (${Prisma.join(articleIds)})
        GROUP BY a.id
      ),
      -- Durable moderation floor: R whenever a Successful text-moderation
      -- record flagged the article as NSFW (via triggeredLabels or blocked),
      -- OR an Actioned NSFW user report exists. Computed fresh on every
      -- recompute so the floor survives image rescans / userNsfwLevel edits
      -- without needing a persisted flag on the Article row. When those
      -- records disappear (e.g. a mod Unactions the report), the floor drops
      -- on the next recompute and the article's level re-derives from
      -- user + image ground truth.
      moderation_floor AS (
        SELECT
          a.id,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM "EntityModeration" em
              WHERE em."entityType" = 'Article'
                AND em."entityId" = a.id
                AND em.status = 'Succeeded'::"EntityModerationStatus"
                AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))
            ) OR EXISTS (
              SELECT 1 FROM "ArticleReport" ar
              JOIN "Report" r ON r.id = ar."reportId"
              WHERE ar."articleId" = a.id
                AND r.reason = 'NSFW'::"ReportReason"
                AND r.status = 'Actioned'::"ReportStatus"
            ) THEN 4 -- NsfwLevel.R
            ELSE 0
          END AS "floor"
        FROM "Article" a
        WHERE a.id IN (${Prisma.join(articleIds)})
      )
      UPDATE "Article" a
      SET "nsfwLevel" = GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
      FROM level
      JOIN moderation_floor mf ON mf.id = level.id
      WHERE level.id = a.id
        AND GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor") != a."nsfwLevel"
      RETURNING a.id;
    `);
  await articlesSearchIndex.queueUpdate(
    articles.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateBountyNsfwLevels(bountyIds: number[]) {
  if (!bountyIds.length) return;
  const bounties = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
      WITH level AS (
        SELECT DISTINCT ON ("entityId")
          "entityId",
          bit_or(i."nsfwLevel") "nsfwLevel"
        FROM "ImageConnection" ic
        JOIN "Image" i ON i.id = ic."imageId"
        JOIN "Bounty" b on b.id = ic."entityId" AND ic."entityType" = 'Bounty'
        WHERE ic."entityType" = 'Bounty' AND ic."entityId" IN (${Prisma.join(bountyIds)})
        GROUP BY 1
      )
      UPDATE "Bounty" b SET "nsfwLevel" = (
        CASE
          WHEN b.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
          ELSE level."nsfwLevel"
        END
      )
      FROM level
      WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
      RETURNING b.id;
    `);
  await bountiesSearchIndex.queueUpdate(
    bounties.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateBountyEntryNsfwLevels(bountyEntryIds: number[]) {
  if (!bountyEntryIds.length) return;
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON ("entityId")
        "entityId",
        bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "ImageConnection" ic
      JOIN "Image" i ON i.id = ic."imageId"
      JOIN "BountyEntry" b on b.id = "entityId" AND ic."entityType" = 'BountyEntry'
      WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" IN (${Prisma.join(bountyEntryIds)})
      GROUP BY 1
    )
    UPDATE "BountyEntry" b SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
    RETURNING b.id;
  `);
}

// Collection nsfwLevel is bucketed: 0=unrated, 1=safe-only, 28=nsfw-only, 29=mixed.
// Safe bucket is stored as PG (1) so unauthed/public browsingLevel=1 matches.
// NSFW bucket = R|X|XXX (28). Blocked (32) is intentionally excluded from the
// bucket value: blocked items are hidden everywhere and shouldn't classify the
// collection. The nsfw-probe still matches on (level & 60) so blocked-only
// items still flip the collection into the nsfw bucket.
//
// Precedence:
//   1. metadata.forcedBrowsingLevel set → map forced bits to bucket
//   2. otherwise → two-probe scan of ACCEPTED items
// Collection.nsfw boolean is ignored — it's auto-flipped by user NSFW reports
// (report.service.ts) so it's not a reliable signal of collection content.
const COLLECTION_NSFW_BUCKET = 28; // R|X|XXX
export async function updateCollectionsNsfwLevels(collectionIds: number[]) {
  if (!collectionIds.length) return;
  const collections = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH collections AS (
      SELECT
        c.id,
        (
          CASE
            WHEN (c.metadata->>'forcedBrowsingLevel') IS NOT NULL
              AND (c.metadata->>'forcedBrowsingLevel') ~ '^[0-9]+$' THEN
              (
                (CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & ${sfwBrowsingLevelsFlag}) != 0 THEN 1 ELSE 0 END)
                | (CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & ${nsfwBrowsingLevelsFlag}) != 0 THEN ${COLLECTION_NSFW_BUCKET} ELSE 0 END)
              )
            ELSE
              (
                (CASE WHEN EXISTS (
                  SELECT 1 FROM "CollectionItem" ci
                  LEFT JOIN "Image"   i ON i.id = ci."imageId"
                  LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
                  LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
                  LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
                  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                    AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & ${sfwBrowsingLevelsFlag}) != 0
                ) THEN 1 ELSE 0 END)
                | (CASE WHEN EXISTS (
                  SELECT 1 FROM "CollectionItem" ci
                  LEFT JOIN "Image"   i ON i.id = ci."imageId"
                  LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
                  LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
                  LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
                  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                    AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & ${nsfwBrowsingLevelsFlag}) != 0
                ) THEN ${COLLECTION_NSFW_BUCKET} ELSE 0 END)
              )
          END
        ) AS "nsfwLevel"
      FROM "Collection" c
      WHERE c."id" IN (${Prisma.join(collectionIds)})
        AND c."availability" = 'Public'
        AND c."read" IN ('Public', 'Unlisted')
    )
    UPDATE "Collection" c
    SET "nsfwLevel" = c2."nsfwLevel"
    FROM collections c2
    WHERE c.id = c2.id
      AND c."nsfwLevel" != c2."nsfwLevel"
    RETURNING c.id;
  `);
  await collectionsSearchIndex.queueUpdate(
    collections.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
  return collections;
}

export async function updateModelNsfwLevels(modelIds: number[]) {
  if (!modelIds.length) return;
  const models = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT
        mv."modelId" as "id",
        bit_or(mv."nsfwLevel") "nsfwLevel"
      FROM "ModelVersion" mv
      WHERE mv."modelId" IN (${Prisma.join(modelIds)})
      AND mv.status = 'Published'
      GROUP BY mv."modelId"
    )
    UPDATE "Model" m
    SET "nsfwLevel" = (
      CASE
        WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
        ELSE level."nsfwLevel"
      END
    )
    FROM level
    WHERE level.id = m.id AND (level."nsfwLevel" != m."nsfwLevel" OR m.nsfw = TRUE)
    RETURNING m.id;
  `);
  await modelsSearchIndex.queueUpdate(
    models.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateModelVersionNsfwLevels(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return;
  const updateSystemNsfwLevel =
    (await sysRedis.hGet(
      REDIS_SYS_KEYS.SYSTEM.FEATURES,
      'update-system-model-version-nsfw-level'
    )) !== 'false';

  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level as (
      SELECT
        mv.id,
        CASE
          WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
          -- WHEN m."userId" = -1 THEN (
          --   SELECT COALESCE(bit_or(ranked."nsfwLevel"), 0) "nsfwLevel"
          --   FROM (
          --     SELECT
          --     ir."imageId" id,
          --     i."nsfwLevel"
          --     FROM "ImageResourceNew" ir
          --     JOIN "Image" i ON i.id = ir."imageId"
          --     JOIN "Post" p ON p.id = i."postId"
          --     JOIN "ImageMetric" im ON im."imageId" = ir."imageId" AND im.timeframe = 'AllTime'::"MetricTimeframe"
          --     WHERE ir."modelVersionId" = mv.id
          --     AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0 AND i."nsfwLevel" != 32
          --     ORDER BY im."reactionCount" DESC
          --     LIMIT 20
          --   ) AS ranked
          -- )
          WHEN m."userId" != -1 THEN (
            SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
            FROM (
              SELECT
                i."nsfwLevel"
              FROM "Post" p
              JOIN "Image" i ON i."postId" = p.id
              WHERE p."modelVersionId" = mv.id
              AND p."userId" = m."userId"
              AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0 AND i."nsfwLevel" != 32
              ORDER BY p."id", i."index"
              LIMIT 20
            ) AS i
          )
        END AS "nsfwLevel"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv.id IN (${Prisma.join(modelVersionIds)})
      ${updateSystemNsfwLevel ? Prisma.sql`` : Prisma.raw('AND m."userId" > 0')}
    )
    UPDATE "ModelVersion" mv
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel"
    RETURNING mv.id;
  `);
}

export async function updateComicChapterNsfwLevels(projectIds: number[]) {
  if (!projectIds.length) return;
  // Use LEFT JOINs so chapters with no remaining panels (or no panel images)
  // get their nsfwLevel reset to 0 instead of being silently skipped.
  await dbWrite.$queryRaw(Prisma.sql`
    WITH level AS (
      SELECT ch."projectId", ch."position" AS "chapterPosition",
             COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
      FROM "ComicChapter" ch
      LEFT JOIN "ComicPanel" p ON p."projectId" = ch."projectId"
        AND p."chapterPosition" = ch."position"
      LEFT JOIN "Image" i ON i.id = p."imageId"
      WHERE ch."projectId" IN (${Prisma.join(projectIds)})
      GROUP BY ch."projectId", ch."position"
    )
    UPDATE "ComicChapter" ch
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE ch."projectId" = level."projectId"
      AND ch."position" = level."chapterPosition"
      AND ch."nsfwLevel" != level."nsfwLevel";
  `);
}

export async function updateComicProjectNsfwLevels(projectIds: number[]) {
  if (!projectIds.length) return;
  await dbWrite.$queryRaw(Prisma.sql`
    WITH level AS (
      SELECT "projectId" as id, COALESCE(bit_or("nsfwLevel"), 0) "nsfwLevel"
      FROM "ComicChapter"
      WHERE "projectId" IN (${Prisma.join(projectIds)})
      GROUP BY "projectId"
    )
    UPDATE "ComicProject" cp
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = cp.id AND level."nsfwLevel" != cp."nsfwLevel";
  `);
}

export async function updateComicNsfwLevelsForImage(imageId: number) {
  const panels = await dbRead.comicPanel.findMany({
    where: { imageId },
    select: { projectId: true },
  });
  if (!panels.length) return;
  const projectIds = [...new Set(panels.map((p) => p.projectId))];
  await updateComicChapterNsfwLevels(projectIds);
  await updateComicProjectNsfwLevels(projectIds);
}
