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
  comicsSearchIndex,
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
  const [images, connections, articles, collectionItems, model3ds] = await Promise.all([
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
    dbRead.model3D.findMany({
      where: { thumbnailImageId: { in: imageIds } },
      select: { id: true },
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
    model3dIds: model3ds.map((x) => x.id),
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
  let model3dIds: number[] = [];

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
      model3dIds: number[];
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
    if (data.model3dIds) model3dIds = uniq(model3dIds.concat(data.model3dIds));
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
    model3dIds,
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
  model3dIds = [],
}: {
  postIds: number[];
  articleIds: number[];
  bountyIds: number[];
  bountyEntryIds: number[];
  collectionIds: number[];
  modelIds: number[];
  modelVersionIds: number[];
  comicProjectIds?: number[];
  model3dIds?: number[];
}) {
  const updatePosts = batcher(postIds, updatePostNsfwLevels);
  const updateArticles = batcher(articleIds, updateArticleNsfwLevels);
  const updateBounties = batcher(bountyIds, updateBountyNsfwLevels);
  const updateBountyEntries = batcher(bountyEntryIds, updateBountyEntryNsfwLevels);
  const updateModelVersions = batcher(modelVersionIds, updateModelVersionNsfwLevels);
  const updateModels = batcher(modelIds, updateModelNsfwLevels);
  const updateComicChapters = batcher(comicProjectIds, updateComicChapterNsfwLevels);
  const updateComicProjects = batcher(comicProjectIds, updateComicProjectNsfwLevels);
  // Model3D nsfwLevel comes from the thumbnail Image alone — no aggregation
  // across child entities, so it can run in the leaf batch alongside Posts /
  // Articles / Bounties (none of those depend on Model3D either).
  const updateModel3Ds = batcher(model3dIds, updateModel3DNsfwLevels);
  // Collections are processed by separate optimized job
  // const updateCollections = batcher(collectionIds, updateCollectionsNsfwLevels);

  const nsfwLevelChangeBatches = [
    [
      updatePosts,
      updateArticles,
      updateBounties,
      updateBountyEntries,
      updateComicChapters,
      updateModel3Ds,
    ],
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

export async function updateArticleNsfwLevels(articleIds: number[], tx?: Prisma.TransactionClient) {
  if (!articleIds.length) return;
  // Run the UPDATE under the caller's transaction when one is supplied so the
  // write participates in any advisory lock / snapshot the caller established
  // (see updateArticleImageScanStatus). The search index queue call below is
  // idempotent and stays out-of-band either way.
  const dbClient = tx ?? dbWrite;
  const articles = await dbClient.$queryRaw<{ id: number }[]>(Prisma.sql`
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

        -- Cover image (left join - may not exist).
        -- Include Blocked covers too: a blocked cover has a real nsfwLevel
        -- (32 == NsfwLevel.Blocked) and MUST contribute to the derivation so
        -- the article drops out of any browsingLevel that doesn't include
        -- Blocked — otherwise a post-publish cover block silently leaves the
        -- article at its author-declared PG/PG13 level.
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id
          AND cover."ingestion" IN ('Scanned', 'Blocked')

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
      -- moderatorNsfwLevel is the moderator override and takes precedence over
      -- every other signal when set. It can force the rating either direction:
      -- mods can pin a wholesome article that got mis-scanned back down to PG,
      -- or raise a borderline article that the auto-derivation undersold.
      -- When null we fall back to GREATEST(userNsfwLevel, scanned images,
      -- moderation floor) as before. A mod clearing the override (setting it
      -- back to NULL) immediately returns the article to auto-derivation.
      UPDATE "Article" a
      SET "nsfwLevel" = COALESCE(
        a."moderatorNsfwLevel",
        GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
      )
      FROM level
      JOIN moderation_floor mf ON mf.id = level.id
      WHERE level.id = a.id
        AND COALESCE(
          a."moderatorNsfwLevel",
          GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
        ) != a."nsfwLevel"
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
// Collection.nsfw boolean is ignored — it's a legacy flag and not a reliable
// signal of collection content.
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

/**
 * Propagate the thumbnail Image's nsfwLevel up to the Model3D row and its
 * denormalized copy on Model3DMetric. Only the thumbnail is scanned in v1
 * (see plan §2.10), so the thumbnail's nsfwLevel is the single signal for
 * the entire Model3D record.
 *
 * Mirrors the `updateModelNsfwLevels` / `updateArticleNsfwLevels` pattern:
 * single SQL pass keyed off Model3D ids, only writes rows whose level has
 * actually changed, returns the affected ids for downstream search-index
 * fan-out (the dedicated `model3d` Meilisearch index lands in Phase 2).
 */
export async function updateModel3DNsfwLevels(model3dIds: number[]): Promise<void> {
  if (!model3dIds.length) return;
  // Honor `lockedProperties` — rows where a mod has manually locked the
  // nsfwLevel (via `setModel3DNsfwLevel({ lock: true })`) must not be
  // clobbered by the thumbnail-derived recompute. We filter at the CTE level
  // so both the Model3D + Model3DMetric branches naturally exclude locked
  // rows. (R8 in `docs/3d-models-followups.md`.)
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT
        m.id,
        COALESCE(i."nsfwLevel", 0) AS "nsfwLevel"
      FROM "Model3D" m
      LEFT JOIN "Image" i ON i.id = m."thumbnailImageId"
      WHERE m.id IN (${Prisma.join(model3dIds)})
        AND NOT ('nsfwLevel' = ANY(m."lockedProperties"))
    ), model_update AS (
      UPDATE "Model3D" m
      SET "nsfwLevel" = level."nsfwLevel"
      FROM level
      WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel"
      RETURNING m.id
    )
    UPDATE "Model3DMetric" mm
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE mm."model3dId" = level.id AND mm."nsfwLevel" != level."nsfwLevel"
    RETURNING mm."model3dId" AS id;
  `);
  // TODO(phase2): queue the dedicated `model3d` Meilisearch index for the
  // affected ids once `model3dSearchIndex` lands (plan §2.9). Currently we
  // intentionally do not surface Model3D via any of the existing search
  // indexes, so there's no fan-out to do here.
}

export async function updateModelVersionNsfwLevels(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return;
  // sysRedis.hGet is typed string but the HA/Sentinel client returns a
  // Buffer for BLOB_STRING replies. `Buffer !== 'false'` is always true,
  // so the kill-switch silently never fires in sentinel mode. Coerce to
  // utf8 string before comparing. See PR #2697 for the canonical case.
  const rawFlag = await sysRedis.hGet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    'update-system-model-version-nsfw-level'
  );
  const flag = Buffer.isBuffer(rawFlag) ? rawFlag.toString('utf8') : rawFlag;
  const updateSystemNsfwLevel = flag !== 'false';

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

// Project nsfwLevel is bit_or'd from chapter nsfwLevels, which are bit_or'd from
// panel image nsfwLevels — so the chapter recompute MUST finish before the project
// recompute runs, otherwise the project reads stale (often 0) chapter levels and
// stays unrated. Use this helper at every callsite instead of firing the two
// underlying functions side-by-side.
export async function updateComicNsfwLevels(projectIds: number[]) {
  if (!projectIds.length) return;
  await updateComicChapterNsfwLevels(projectIds);
  await updateComicProjectNsfwLevels(projectIds);
}

export async function updateComicNsfwLevelsForImage(imageId: number) {
  const panels = await dbRead.comicPanel.findMany({
    where: { imageId },
    select: { projectId: true },
  });
  if (!panels.length) return;
  const projectIds = [...new Set(panels.map((p) => p.projectId))];
  await updateComicNsfwLevels(projectIds);
}

/**
 * Queue the parent comic project(s) of `imageId` for a Meilisearch refresh.
 *
 * Called any time a panel image's moderation-relevant state changes —
 * `ingestion`, `needsReview`, or `tosViolation`. The comics search index's
 * WHERE clause (`comics.search-index.ts`) gates project visibility on
 * those exact fields, so without this hook, mod-driven block/unblock /
 * appeal flows would leave the comic indexed under its old (visible)
 * state even after the listing route would hide it.
 *
 * Safe to fire-and-forget — only does work when the image is actually
 * tied to a comic panel.
 */
export async function queueComicsForPanelImage(imageId: number) {
  const panels = await dbRead.comicPanel.findMany({
    where: { imageId },
    select: { projectId: true },
  });
  if (!panels.length) return;
  const projectIds = [...new Set(panels.map((p) => p.projectId))];
  await comicsSearchIndex.queueUpdate(
    projectIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

/**
 * Same as {@link queueComicsForPanelImage} but for a batch of image IDs.
 * Used by moderator bulk paths (block/unblock/appeal) that touch many
 * images at once.
 */
export async function queueComicsForPanelImages(imageIds: number[]) {
  if (!imageIds.length) return;
  const panels = await dbRead.comicPanel.findMany({
    where: { imageId: { in: imageIds } },
    select: { projectId: true },
  });
  if (!panels.length) return;
  const projectIds = [...new Set(panels.map((p) => p.projectId))];
  await comicsSearchIndex.queueUpdate(
    projectIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

/**
 * Prompt inline recompute of a Model3D's nsfwLevel from its thumbnail Image,
 * for the image scan/mod paths. Call it unconditionally with the image's
 * `postId` — a Model3D thumbnail is always a standalone image (no post — see
 * `ingestThumbnailImage`), so a posted image provably isn't a thumbnail and
 * short-circuits before the lookup. Keeping that gate here (not at each call
 * site) lets callers treat it as a plain fire-and-forget side effect. The
 * `update-nsfw-levels` cron independently re-derives Model3Ds from changed
 * images (`getImageConnectedEntities`), so a rare replica-lag miss here still
 * heals on the next tick — no `dbWrite` needed.
 *
 * NB: the `postId` short-circuit is specific to Model3D. Do NOT copy it to the
 * comic-panel lookups nearby — a comic panel's image CAN be posted (import mode
 * links an existing image), so gating those on `!postId` would skip real work.
 */
export async function updateModel3DNsfwLevelForThumbnailImage({
  imageId,
  postId,
}: {
  imageId: number;
  postId: number | null;
}) {
  if (postId != null) return;
  const model3ds = await dbRead.model3D.findMany({
    where: { thumbnailImageId: imageId },
    select: { id: true },
  });
  if (model3ds.length) await updateModel3DNsfwLevels(model3ds.map((m) => m.id));
}
