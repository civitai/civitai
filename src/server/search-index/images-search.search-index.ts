import { Prisma } from '@prisma/client';
import type { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { clickhouse } from '~/server/clickhouse/client';
import { IMAGES_SEARCH_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { isDefined } from '~/utils/type-guards';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = IMAGES_SEARCH_SEARCH_INDEX;

/**
 * Slim image search index for agent use.
 *
 * Scope: images posted OR reacted-to in the last 90 days.
 * Documents are intentionally minimal (prompt, tags, base model, user)
 * to keep the index small enough for Meilisearch to handle.
 */

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) return;

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  if (!index) return;

  const settings = await index.getSettings();

  const searchableAttributes: SearchableAttributes = [
    'prompt',
    'tagNames',
    'user.username',
  ];

  const sortableAttributes: SortableAttributes = ['id', 'sortAt'];

  const filterableAttributes: FilterableAttributes = [
    'id',
    'nsfwLevel',
    'baseModel',
    'type',
    'tagNames',
    'user.username',
    'toolNames',
    'techniqueNames',
  ];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    await index.updateSearchableAttributes(searchableAttributes);
  }

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    await index.updateSortableAttributes(sortableAttributes);
  }

  if (
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    await index.updateFilterableAttributes(filterableAttributes);
  }
};

// ---------------------------------------------------------------------------
// WHERE clause shared across pullData queries
// ---------------------------------------------------------------------------
const imageWhere = [
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
  Prisma.sql`p."availability" != 'Unsearchable'::"Availability"`,
  Prisma.sql`p."publishedAt" <= NOW()`,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ImageRow = {
  id: number;
  sortAt: Date;
  nsfwLevel: number;
  type: string;
  userId: number;
  username: string;
  prompt: string | null;
  postId: number;
};

type ImageTag = { imageId: number; tagName: string };
type ImageTool = { imageId: number; toolName: string };
type ImageTechnique = { imageId: number; techniqueName: string };
type ImageBaseModel = { imageId: number; baseModel: string };

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------
const transformData = async ({
  images,
  tags,
  tools,
  techniques,
  baseModels,
}: {
  images: ImageRow[];
  tags: ImageTag[];
  tools: ImageTool[];
  techniques: ImageTechnique[];
  baseModels: ImageBaseModel[];
}) => {
  // Build lookup maps
  const tagMap = new Map<number, string[]>();
  for (const t of tags) {
    const arr = tagMap.get(t.imageId) ?? [];
    arr.push(t.tagName);
    tagMap.set(t.imageId, arr);
  }

  const toolMap = new Map<number, string[]>();
  for (const t of tools) {
    const arr = toolMap.get(t.imageId) ?? [];
    arr.push(t.toolName);
    toolMap.set(t.imageId, arr);
  }

  const techniqueMap = new Map<number, string[]>();
  for (const t of techniques) {
    const arr = techniqueMap.get(t.imageId) ?? [];
    arr.push(t.techniqueName);
    techniqueMap.set(t.imageId, arr);
  }

  const baseModelMap = new Map<number, string>();
  for (const bm of baseModels) {
    if (bm.baseModel) baseModelMap.set(bm.imageId, bm.baseModel);
  }

  return images
    .map((img) => ({
      id: img.id,
      sortAt: img.sortAt,
      nsfwLevel: img.nsfwLevel,
      type: img.type,
      postId: img.postId,
      prompt: img.prompt ? img.prompt.slice(0, 500) : null,
      user: {
        id: img.userId,
        username: img.username,
      },
      tagNames: tagMap.get(img.id) ?? [],
      toolNames: toolMap.get(img.id) ?? [],
      techniqueNames: techniqueMap.get(img.id) ?? [],
      baseModel: baseModelMap.get(img.id) ?? null,
    }))
    .filter((doc) => doc.prompt || doc.tagNames.length > 0);
};

export type ImageSearchRecord = Awaited<ReturnType<typeof transformData>>[number];

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------
export const imagesSearchSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 100,
  prepareBatches: async ({ pg, logger }, lastUpdatedAt) => {
    // For incremental updates, scan from images created since last run
    // For full builds, scan from images created in the last 90 days
    const cutoff = lastUpdatedAt ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const rangeQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT
        COALESCE((
          SELECT id FROM "Image"
          WHERE "createdAt" >= '${cutoff.toISOString()}'
          ORDER BY "createdAt" LIMIT 1
        ), 0) as "startId",
        COALESCE((SELECT MAX(id) FROM "Image"), 0) as "endId"
    `);
    const rangeResult = await rangeQuery.result();
    const { startId, endId } = rangeResult[0];

    // For full builds, also grab old images that got recent reactions (from ClickHouse)
    let updateIds: number[] = [];
    if (!lastUpdatedAt) {
      try {
        const reactedImages = await clickhouse?.$query<{ entityId: number }>(`
          SELECT DISTINCT entityId
          FROM reactions
          WHERE type = 'Image_Create'
            AND time > now() - INTERVAL 90 DAY
            AND entityId < ${startId}
          ORDER BY entityId
        `);
        updateIds = reactedImages?.map((r) => r.entityId) ?? [];
        logger(
          `prepareBatches :: Found ${updateIds.length} old images with recent reactions`
        );
      } catch (e) {
        logger(`prepareBatches :: ClickHouse query failed, skipping reacted images: ${e}`);
      }
    } else {
      // Incremental: find images updated since last run
      const updatedQuery = await pg.cancellableQuery<{ id: number }>(`
        SELECT id FROM "Image"
        WHERE "updatedAt" > '${lastUpdatedAt.toISOString()}'
          AND "postId" IS NOT NULL
        ORDER BY id
      `);
      updateIds = (await updatedQuery.result()).map((x) => x.id);
    }

    logger(
      `prepareBatches :: range ${startId}-${endId}, updateIds: ${updateIds.length}`
    );

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
      updateIds,
    };
  },
  pullData: async ({ pg, logger }, batch) => {
    const where = [
      ...imageWhere,
      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`i.id >= ${batch.startId} AND i.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    // Step 1: Base image data with prompt from meta JSONB
    const imagesQuery = await pg.cancellableQuery<ImageRow>(`
      SELECT
        i.id,
        GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
        i."nsfwLevel",
        i."type",
        i."userId",
        u."username",
        i."postId",
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
          THEN LEFT(i.meta->>'prompt', 500)
          ELSE NULL
        END as prompt
      FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" u ON u.id = i."userId"
      WHERE ${Prisma.join(where, ' AND ')}
    `);
    const images = await imagesQuery.result();

    if (images.length === 0) {
      return { images: [], tags: [], tools: [], techniques: [], baseModels: [] };
    }

    const ids = images.map((img) => img.id);

    // Step 2: Tags
    const tagsQuery = await pg.cancellableQuery<ImageTag>(`
      SELECT toi."imageId", t.name as "tagName"
      FROM "TagsOnImage" toi
      JOIN "Tag" t ON t.id = toi."tagId"
      WHERE toi."imageId" IN (${ids.join(',')})
        AND NOT t."unlisted"
    `);
    const tags = await tagsQuery.result();

    // Step 3: Tools
    const toolsQuery = await pg.cancellableQuery<ImageTool>(`
      SELECT it."imageId", t.name as "toolName"
      FROM "ImageTool" it
      JOIN "Tool" t ON t.id = it."toolId"
      WHERE it."imageId" IN (${ids.join(',')})
    `);
    const tools = await toolsQuery.result();

    // Step 4: Techniques
    const techniquesQuery = await pg.cancellableQuery<ImageTechnique>(`
      SELECT it."imageId", t.name as "techniqueName"
      FROM "ImageTechnique" it
      JOIN "Technique" t ON t.id = it."techniqueId"
      WHERE it."imageId" IN (${ids.join(',')})
    `);
    const techniques = await techniquesQuery.result();

    // Step 5: Base model (from checkpoint resources)
    const baseModelsQuery = await pg.cancellableQuery<ImageBaseModel>(`
      SELECT
        ir."imageId",
        string_agg(
          CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, ''
        ) as "baseModel"
      FROM "ImageResourceNew" ir
      JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE ir."imageId" IN (${ids.join(',')})
      GROUP BY ir."imageId"
    `);
    const baseModels = await baseModelsQuery.result();

    logger(
      `pullData :: ${images.length} images, ${tags.length} tags, ${tools.length} tools, ${techniques.length} techniques`
    );

    return { images, tags, tools, techniques, baseModels };
  },
  transformData,
  pushData: async ({ indexName }, records) => {
    await updateDocs({
      indexName,
      documents: records as any[],
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });
  },
});
