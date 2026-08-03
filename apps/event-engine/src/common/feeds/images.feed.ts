import { createFeed } from './base';
import type { FeedContext } from './types';
import type {
  ImageDocument,
  ImageQueryInput,
  PopulatedImage,
  SearchBaseImage,
  ImageStats,
  ImageSort,
  ImageFlags,
} from '../types/image-feed-types';
import {
  NsfwLevel,
  Availability,
  browsingLevelToArray,
  includesNsfwContent,
  onlySelectableLevels,
  snapToInterval,
} from '../types/image-feed-types';
import { chunk } from '../utils/basic';
import {
  NSFW_RESTRICTED_BASE_MODELS,
  NSFW_RESTRICTED_LEVELS,
  FEED_REDIS_KEYS,
} from '../constants/feed.constants';

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Comprehensive schema for Image Feed
 * Matches the structure in metrics-images.search-index.ts
 */
const schema = {
  // Primary
  id: { type: 'number' as const, primary: true, filterable: true },
  index: { type: 'number' as const, sortable: true },

  // Basic fields
  sortAt: { type: 'Date' as const, sortable: true },
  sortAtUnix: { type: 'number' as const, filterable: true },
  type: { type: 'string' as const, filterable: true },
  userId: { type: 'number' as const, filterable: true },
  postId: { type: 'number' as const, filterable: true },

  // Model/Resource fields
  modelVersionIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  modelVersionIdsManual: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  postedToId: { type: 'number' as const, filterable: true },
  baseModel: { type: 'string' as const, filterable: true },

  // NSFW/Content Safety
  nsfwLevel: { type: 'number' as const, filterable: true },
  combinedNsfwLevel: { type: 'number' as const, filterable: true },
  availability: { type: 'string' as const, filterable: true },
  blockedFor: { type: 'string' as const, filterable: true },
  poi: { type: 'boolean' as const, filterable: true },
  minor: { type: 'boolean' as const, filterable: true },

  // Tags/Tools/Techniques
  tagIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  toolIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  techniqueIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },

  // Metadata
  hasMeta: { type: 'boolean' as const, filterable: true },
  onSite: { type: 'boolean' as const, filterable: true },
  publishedAtUnix: { type: 'number' as const, filterable: true },
  existedAtUnix: { type: 'number' as const, filterable: true },
  remixOfId: { type: 'number' as const, filterable: true },

  // Flags
  'flags.promptNsfw': { type: 'boolean' as const, filterable: true },

  // Metrics - need to be both sortable and filterable for cursor pagination
  reactionCount: { type: 'number' as const, sortable: true, filterable: true },
  commentCount: { type: 'number' as const, sortable: true, filterable: true },
  collectedCount: { type: 'number' as const, sortable: true, filterable: true },
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build Meilisearch filter string helper
 */
function makeFilter(field: string, operator: string): string {
  return `${field} ${operator}`;
}

/**
 * Quote array of strings for Meilisearch
 */
function strArray(arr: string[]): string {
  return arr.map((s) => `'${s}'`).join(',');
}

/**
 * Remove empty/undefined values from object
 */
function removeEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v != null)
  ) as Partial<T>;
}

// ============================================================================
// createDocuments Implementation
// ============================================================================

type ModelVersionData = {
  id: number;
  baseModel: string;
  modelVersionIdsAuto: number[];
  modelVersionIdsManual: number[];
  poi: boolean;
};

type ImageToolData = {
  imageId: number;
  toolId: number;
};

type ImageTechniqueData = {
  imageId: number;
  techniqueId: number;
};

/**
 * Create documents for Meilisearch from image IDs
 * Replicates logic from metrics-images.search-index.ts
 */
async function createDocuments(
  ctx: FeedContext<'Image'>,
  ids: number[],
  type: 'full' | 'metrics' = 'full'
): Promise<ImageDocument[]> {
  // For metrics-only updates, just fetch and update metrics
  if (type === 'metrics') {
    const metricsData = await ctx.metric.fetch(ids);
    const docs: ImageDocument[] = ids.map((id) => {
      const metrics = metricsData[id];
      return {
        id,
        reactionCount:
          (metrics?.ReactionHeart ?? 0) +
          (metrics?.ReactionLike ?? 0) +
          (metrics?.ReactionLaugh ?? 0) +
          (metrics?.ReactionCry ?? 0),
        commentCount: metrics?.Comment ?? 0,
        collectedCount: metrics?.Collection ?? 0,
      } as ImageDocument;
    });
    return docs;
  }

  // Full document creation
  const batches = chunk(ids, 1000);
  const allDocs: ImageDocument[] = [];

  for (const batch of batches) {
    // Step 1: Fetch base image data from PostgreSQL
    const images = await ctx.pg.query<SearchBaseImage>(`
      SELECT
        i."id",
        i."index",
        i."postId",
        i."url",
        i."nsfwLevel",
        i."aiNsfwLevel",
        i."nsfwLevelLocked",
        i."width",
        i."height",
        i."hash",
        i."hideMeta",
        GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
        i."type",
        i."userId",
        i."needsReview",
        i."blockedFor",
        i.minor,
        i.poi,
        i."acceptableMinor",
        p."publishedAt",
        p."availability",
        (
          CASE
            WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            THEN TRUE
            ELSE FALSE
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
        (
          CASE
            WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
              OR i.meta->>'workflow' IS NOT NULL
            THEN TRUE
            ELSE FALSE
          END
        ) as "onSite",
        p."modelVersionId" as "postedToId",
        (i."meta"->'extra'->>'remixOfId')::int as "remixOfId",
        (i."meta"->>'promptNsfw')::boolean as "promptNsfw"
      FROM "Image" i
      JOIN "Post" p ON p."id" = i."postId"
      WHERE i.id = ANY($1)
    `, [batch]);

    if (images.length === 0) continue;

    const imageIds = images.map((img) => img.id);

    // Step 2: Fetch metrics from ClickHouse via metric service
    const metricsData = await ctx.metric.fetch(imageIds);

    // Step 3: Fetch tags from cache
    const imageTagIdsData = await ctx.cache.fetch('imageTagIds', imageIds);

    // Step 4: Fetch tools and techniques from PostgreSQL
    const tools = await ctx.pg.query<ImageToolData>(`
      SELECT "imageId", "toolId"
      FROM "ImageTool"
      WHERE "imageId" = ANY($1)
    `, [imageIds]);

    const techniques = await ctx.pg.query<ImageTechniqueData>(`
      SELECT "imageId", "techniqueId"
      FROM "ImageTechnique"
      WHERE "imageId" = ANY($1)
    `, [imageIds]);

    // Step 5: Fetch model versions from PostgreSQL
    const modelVersions = await ctx.pg.query<ModelVersionData>(`
      SELECT
        ir."imageId" as id,
        string_agg(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '') as "baseModel",
        coalesce(array_agg(mv."id") FILTER (WHERE ir.detected is true), '{}') as "modelVersionIdsAuto",
        coalesce(array_agg(mv."id") FILTER (WHERE ir.detected is not true), '{}') as "modelVersionIdsManual",
        (SUM(CASE WHEN m.poi THEN 1 ELSE 0 END) > 0) as "poi"
      FROM "ImageResourceNew" ir
      JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
      JOIN "Model" m ON mv."modelId" = m."id"
      WHERE ir."imageId" = ANY($1)
      GROUP BY ir."imageId"
    `, [imageIds]);

    // Step 6: Transform and combine all data
    const docs: ImageDocument[] = images.map(({ publishedAt, nsfwLevelLocked, promptNsfw, ...imageRecord }) => {
      const imageTools = tools.filter((t) => t.imageId === imageRecord.id);
      const imageTechniques = techniques.filter((t) => t.imageId === imageRecord.id);

      const versionInfo = modelVersions.find((mv) => mv.id === imageRecord.id) || {
        modelVersionIdsAuto: [] as number[],
        modelVersionIdsManual: [] as number[],
        baseModel: '',
        poi: false,
      };

      const metrics = metricsData[imageRecord.id];
      const reactionCount =
        (metrics?.ReactionHeart ?? 0) +
        (metrics?.ReactionLike ?? 0) +
        (metrics?.ReactionLaugh ?? 0) +
        (metrics?.ReactionCry ?? 0);

      const flags: ImageFlags = removeEmpty({ promptNsfw });

      return {
        // Base fields
        id: imageRecord.id,
        index: imageRecord.index,
        postId: imageRecord.postId,
        url: imageRecord.url,
        width: imageRecord.width,
        height: imageRecord.height,
        hash: imageRecord.hash,
        hideMeta: imageRecord.hideMeta,
        sortAt: imageRecord.sortAt,
        type: imageRecord.type,
        userId: imageRecord.userId,
        needsReview: imageRecord.needsReview,
        blockedFor: imageRecord.blockedFor,
        minor: imageRecord.minor,
        acceptableMinor: imageRecord.acceptableMinor,
        availability: imageRecord.availability,
        hasMeta: imageRecord.hasMeta,
        hasPositivePrompt: imageRecord.hasPositivePrompt,
        onSite: imageRecord.onSite,
        postedToId: imageRecord.postedToId,
        remixOfId: imageRecord.remixOfId,

        // NSFW levels
        nsfwLevel: imageRecord.nsfwLevel,
        aiNsfwLevel: imageRecord.aiNsfwLevel,
        combinedNsfwLevel: nsfwLevelLocked
          ? imageRecord.nsfwLevel
          : Math.max(imageRecord.nsfwLevel, imageRecord.aiNsfwLevel),

        // POI - best detection from processed images or resource
        poi: imageRecord.poi ?? versionInfo.poi,

        // Model version data
        baseModel: versionInfo.baseModel,
        modelVersionIds: versionInfo.modelVersionIdsAuto,
        modelVersionIdsManual: versionInfo.modelVersionIdsManual,

        // Tools and techniques
        toolIds: imageTools.map((t) => t.toolId),
        techniqueIds: imageTechniques.map((t) => t.techniqueId),

        // Timestamps
        publishedAt,
        publishedAtUnix: publishedAt?.getTime(),
        existedAtUnix: Date.now(),
        sortAtUnix: imageRecord.sortAt.getTime(),

        // Tags
        tagIds: imageTagIdsData[imageRecord.id]?.tags ?? [],

        // Flags
        flags: Object.keys(flags).length > 0 ? flags : undefined,

        // Metrics
        reactionCount,
        commentCount: metrics?.Comment ?? 0,
        collectedCount: metrics?.Collection ?? 0,
      };
    });

    allDocs.push(...docs);
  }

  return allDocs;
}

// ============================================================================
// queryDocuments Implementation
// ============================================================================

type HiddenImageData = {
  imageId: number;
};

type FollowedUserData = {
  targetUserId: number;
};

type UserIdData = {
  id: number;
};

/**
 * Query documents from Meilisearch
 * Replicates filter logic from getImagesFromSearchPostFilter
 */
async function queryDocuments(
  ctx: FeedContext<'Image'>,
  input: ImageQueryInput
): Promise<ImageDocument[]> {
  console.log('[ImageFeed:queryDocuments] Starting query with input:', {
    sort: input.sort,
    userId: input.userId,
    browsingLevel: input.browsingLevel,
    currentUserId: input.currentUserId,
    isModerator: input.isModerator,
    limit: ctx.pagination.limit,
    filters: Object.keys(input).filter(k => input[k as keyof ImageQueryInput] !== undefined && k !== 'sort'),
  });
  const queryStart = Date.now();

  try {

  const {
    sort = 'Newest' as ImageSort,
    modelVersionId,
    types,
    withMeta,
    fromPlatform,
    notPublished,
    scheduled,
    username,
    tags,
    tools,
    techniques,
    baseModels,
    period,
    isModerator,
    currentUserId,
    excludedUserIds,
    hideAutoResources,
    hideManualResources,
    hidden,
    followed,
    postId,
    useCombinedNsfwLevel,
    remixOfId,
    remixesOnly,
    nonRemixesOnly,
    excludedTagIds,
    disablePoi,
    disableMinor,
    requiringMeta,
    poiOnly,
    minorOnly,
    blockedFor,
  } = input;
  let { browsingLevel, userId } = input;
  let { postIds = [] } = input;

  const sorts: string[] = [];
  const filters: string[] = [];

  console.log('[ImageFeed:queryDocuments] Step 1: Building basic filters...');

  // Combine postId into postIds array
  if (postId) {
    postIds = [...postIds, postId];
  }

  // POI and Minor filtering
  if (disablePoi) {
    filters.push(makeFilter('poi', '!= true'));
  }
  if (disableMinor) {
    filters.push(makeFilter('minor', '!= true'));
  }

  // Moderator-only filters
  if (isModerator) {
    if (poiOnly) {
      filters.push(makeFilter('poi', '= true'));
    }
    if (minorOnly) {
      filters.push(makeFilter('minor', '= true'));
    }
    if (blockedFor?.length) {
      filters.push(makeFilter('blockedFor', `IN [${strArray(blockedFor)}]`));
    }
  }

  console.log('[ImageFeed:queryDocuments] Step 2: Processing special filters (hidden/followed/username)...');

  // Handle "hidden" filter - fetch hidden images for current user
  if (hidden) {
    console.log('[ImageFeed:queryDocuments] Fetching hidden images for user:', currentUserId);
    const dbStart = Date.now();
    if (!currentUserId) {
      console.log('[ImageFeed:queryDocuments] No currentUserId, returning empty');
      return []; // No auth, can't get hidden images
    }
    const hiddenImages = await ctx.pg.query<HiddenImageData>(`
      SELECT "imageId"
      FROM "ImageEngagement"
      WHERE "userId" = $1 AND type = 'Hide'
    `, [currentUserId]);

    console.log(`[ImageFeed:queryDocuments] Found ${hiddenImages.length} hidden images in ${Date.now() - dbStart}ms`);

    const imageIds = hiddenImages.map((x) => x.imageId);
    if (imageIds.length) {
      filters.push(makeFilter('id', `IN [${imageIds.join(',')}]`));
    } else {
      console.log('[ImageFeed:queryDocuments] No hidden images found, returning empty');
      return []; // No hidden images
    }
  }

  // Handle "followed" filter - fetch followed users
  if (followed && currentUserId) {
    console.log('[ImageFeed:queryDocuments] Fetching followed users for user:', currentUserId);
    const dbStart = Date.now();
    const followedUsers = await ctx.pg.query<FollowedUserData>(`
      SELECT "targetUserId"
      FROM "UserEngagement"
      WHERE "userId" = $1 AND type = 'Follow'
    `, [currentUserId]);

    console.log(`[ImageFeed:queryDocuments] Found ${followedUsers.length} followed users in ${Date.now() - dbStart}ms`);

    const userIds = followedUsers.map((x) => x.targetUserId);
    if (userIds.length) {
      filters.push(makeFilter('userId', `IN [${userIds.join(',')}]`));
    } else {
      console.log('[ImageFeed:queryDocuments] No followed users found, returning empty');
      return []; // No followed users
    }
  }

  // Username to userId conversion
  if (username && !userId) {
    console.log('[ImageFeed:queryDocuments] Converting username to userId:', username);
    const dbStart = Date.now();
    const users = await ctx.pg.query<UserIdData>(`
      SELECT id FROM "User" WHERE username = $1
    `, [username]);
    console.log(`[ImageFeed:queryDocuments] Username lookup took ${Date.now() - dbStart}ms`);
    if (users.length === 0) {
      console.log('[ImageFeed:queryDocuments] User not found, returning empty');
      return []; // User not found
    }
    userId = users[0].id;
    console.log('[ImageFeed:queryDocuments] Resolved userId:', userId);
  }

  console.log('[ImageFeed:queryDocuments] Step 3: NSFW filtering...', { browsingLevel, useCombinedNsfwLevel });

  // NSFW Level Filtering
  if (!browsingLevel) browsingLevel = 1; // NsfwLevel.PG
  else browsingLevel = onlySelectableLevels(browsingLevel);

  const browsingLevels = browsingLevelToArray(browsingLevel);
  const includesNsfw = includesNsfwContent(browsingLevel);

  console.log('[ImageFeed:queryDocuments] NSFW levels:', { browsingLevels, includesNsfw });

  // Allow moderators to see unscanned content (nsfwLevel = 0)
  if (isModerator && includesNsfw) {
    browsingLevels.push(0);
  }

  const nsfwLevelField = useCombinedNsfwLevel ? 'combinedNsfwLevel' : 'nsfwLevel';
  const nsfwFilters = [makeFilter(nsfwLevelField, `IN [${browsingLevels.join(',')}]`)];

  // Allow users to see their own unscanned content
  if (currentUserId && userId === currentUserId) {
    nsfwFilters.push(makeFilter(nsfwLevelField, '= 0'));
  }

  filters.push(`(${nsfwFilters.join(' OR ')})`);
  console.log('[ImageFeed:queryDocuments] NSFW filter added');

  // NSFW License Restrictions Filter
  // Filter out images with R/X/XXX NSFW levels that use restricted base models
  if (NSFW_RESTRICTED_BASE_MODELS.length > 0) {
    const restrictedBaseModelsQuoted = NSFW_RESTRICTED_BASE_MODELS.map((bm: string) => `'${bm}'`);

    // Exclude images that have BOTH restricted NSFW levels AND restricted base models
    filters.push(
      `NOT (${nsfwLevelField} IN [${NSFW_RESTRICTED_LEVELS.join(',')}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`
    );
    console.log('[ImageFeed:queryDocuments] NSFW restricted base models filter added');
  }

  console.log('[ImageFeed:queryDocuments] Step 4: Content filters (model versions, remixes, tags, etc.)...');

  // Model Version Filtering
  if (modelVersionId) {
    const versionFilters = [makeFilter('postedToId', `= ${modelVersionId}`)];

    if (!hideAutoResources) {
      versionFilters.push(makeFilter('modelVersionIds', `IN [${modelVersionId}]`));
    }
    if (!hideManualResources) {
      versionFilters.push(makeFilter('modelVersionIdsManual', `IN [${modelVersionId}]`));
    }

    filters.push(`(${versionFilters.join(' OR ')})`);
  }

  // Remix Filtering
  if (remixOfId) {
    filters.push(makeFilter('remixOfId', `= ${remixOfId}`));
  }
  if (remixesOnly && !nonRemixesOnly) {
    filters.push(makeFilter('remixOfId', '>= 0'));
  }
  if (nonRemixesOnly) {
    filters.push(makeFilter('remixOfId', 'NOT EXISTS'));
  }

  // Excluded Tags
  if (excludedTagIds?.length) {
    filters.push(makeFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
  }

  // Metadata Filters
  if (withMeta) {
    filters.push(makeFilter('hasMeta', '= true'));
  }
  if (requiringMeta) {
    filters.push(`("blockedFor" = 'AiNotVerified')`);
  }
  if (fromPlatform) {
    filters.push(makeFilter('onSite', '= true'));
  }

  // Publishing Status Filtering
  const snappedNow = snapToInterval(Date.now());
  const currentTime = Date.now();
  if (isModerator) {
    if (notPublished) {
      const filter = makeFilter('publishedAtUnix', 'NOT EXISTS');
      filters.push(filter);
      console.log('[ImageFeed:queryDocuments] NOT PUBLISHED filter:', filter);
    } else if (scheduled) {
      const filter = makeFilter('publishedAtUnix', `> ${currentTime}`);
      filters.push(filter);
      console.log('[ImageFeed:queryDocuments] SCHEDULED filter:', filter, 'currentTime:', currentTime, new Date(currentTime).toISOString());
    } else {
      const publishedFilters = [makeFilter('publishedAtUnix', `<= ${currentTime}`)];
      if (currentUserId) {
        publishedFilters.push(makeFilter('userId', `= ${currentUserId}`));
      }
      const filter = `(${publishedFilters.join(' OR ')})`;
      filters.push(filter);
      console.log('[ImageFeed:queryDocuments] DEFAULT PUBLISHED filter:', filter);
    }
  } else if (!userId) {
    // General feed - apply published filter for caching
    const filter = makeFilter('publishedAtUnix', `<= ${snappedNow}`);
    filters.push(filter);
    console.log('[ImageFeed:queryDocuments] GENERAL PUBLISHED filter:', filter, 'snappedNow:', snappedNow);
  }

  // Type Filtering
  if (types?.length) {
    filters.push(makeFilter('type', `IN [${types.join(',')}]`));
  }

  // Tag/Tool/Technique Filtering
  if (tags?.length) {
    filters.push(makeFilter('tagIds', `IN [${tags.join(',')}]`));
  }
  if (tools?.length) {
    filters.push(makeFilter('toolIds', `IN [${tools.join(',')}]`));
  }
  if (techniques?.length) {
    filters.push(makeFilter('techniqueIds', `IN [${techniques.join(',')}]`));
  }

  // Post ID Filtering
  if (postIds?.length) {
    filters.push(makeFilter('postId', `IN [${postIds.join(',')}]`));
  }

  // Base Model Filtering
  if (baseModels?.length) {
    filters.push(makeFilter('baseModel', `IN [${strArray(baseModels)}]`));
  }

  // User Filtering
  if (userId) {
    filters.push(makeFilter('userId', `= ${userId}`));
  } else if (excludedUserIds?.length) {
    filters.push(makeFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));
  }

  // Period Filtering
  if (period && period !== 'AllTime') {
    const periodMs: Record<string, number> = {
      Day: 24 * 60 * 60 * 1000,
      Week: 7 * 24 * 60 * 60 * 1000,
      Month: 30 * 24 * 60 * 60 * 1000,
      Year: 365 * 24 * 60 * 60 * 1000,
    };
    const afterDate = Date.now() - periodMs[period];
    filters.push(makeFilter('sortAtUnix', `> ${snapToInterval(afterDate)}`));
  }

  console.log('[ImageFeed:queryDocuments] Step 5: Building sort order...', { sort });

  // Sort Order
  let searchSort: string;
  if (sort === 'Most Comments' as ImageSort) {
    searchSort = 'commentCount:desc';
  } else if (sort === 'Most Reactions' as ImageSort) {
    searchSort = 'reactionCount:desc';
  } else if (sort === 'Most Collected' as ImageSort) {
    searchSort = 'collectedCount:desc';
  } else if (sort === 'Oldest' as ImageSort) {
    searchSort = 'sortAt:asc';
  } else {
    searchSort = 'sortAt:desc';
  }
  sorts.push(searchSort);
  // Note: NOT adding secondary sort by ID to match current getAllImagesIndex behavior
  // sorts.push('id:desc'); // Secondary sort for consistency

  // Execute search with offset-based pagination from context
  const { limit, offset = 0 } = ctx.pagination;
  console.log('[ImageFeed:queryDocuments] Using offset-based pagination:', { limit, offset });

  const finalFilter = filters.length ? filters.join(' AND ') : undefined;

  console.log('[ImageFeed:queryDocuments] Final search params:', {
    filterCount: filters.length,
    filter: finalFilter,
    sorts,
    limit: limit + 1,
  });

  if (finalFilter) {
    console.log('[ImageFeed:queryDocuments] Filter details:', finalFilter.substring(0, 500) + (finalFilter.length > 500 ? '...' : ''));
  }

  const searchStart = Date.now();
  const result = await ctx.index.search<ImageDocument>(null, {
    filter: finalFilter,
    sort: sorts,
    limit: limit + 1, // Get one extra to determine if there's a next page
    offset, // Use offset from pagination context
  });

  console.log(`[ImageFeed:queryDocuments] Meilisearch query completed in ${Date.now() - searchStart}ms, returned ${result.hits.length} hits`);
  console.log(`[ImageFeed:queryDocuments] Total query time: ${Date.now() - queryStart}ms`);

  // Log first and last hit for debugging pagination
  if (result.hits.length > 0) {
    const firstHit = result.hits[0];
    const lastHit = result.hits[result.hits.length - 1];
    console.log('[ImageFeed:queryDocuments] First hit:', { id: firstHit.id, sortAtUnix: firstHit.sortAtUnix });
    console.log('[ImageFeed:queryDocuments] Last hit:', { id: lastHit.id, sortAtUnix: lastHit.sortAtUnix });

    if (result.hits.length > limit) {
      const willReturnLast = result.hits[limit - 1];
      console.log('[ImageFeed:queryDocuments] Last item to be returned (before cursor):', {
        id: willReturnLast.id,
        sortAtUnix: willReturnLast.sortAtUnix,
        nextCursor: `${willReturnLast.sortAtUnix}:${willReturnLast.id}`
      });
    }
  }

  // Return all hits including the extra one - base query() will handle slicing and cursor extraction
  return result.hits;

  } catch (error) {
    console.error('[ImageFeed:queryDocuments] ERROR occurred:', error);
    console.error('[ImageFeed:queryDocuments] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    console.error('[ImageFeed:queryDocuments] Query failed after', Date.now() - queryStart, 'ms');
    throw error;
  }
}

// ============================================================================
// populateDocuments Implementation
// ============================================================================

/**
 * Helper: Fetch user reactions for images
 */
async function fetchUserReactions(
  ctx: FeedContext<'Image'>,
  imageIds: number[],
  userId: number
): Promise<Record<number, string[]>> {
  const results = await ctx.pg.query<{ imageId: number; reaction: string }>(`
    SELECT "imageId", reaction
    FROM "ImageReaction"
    WHERE "imageId" = ANY($1) AND "userId" = $2
  `, [imageIds, userId]);

  return results.reduce((acc, { imageId, reaction }) => {
    acc[imageId] ??= [];
    acc[imageId].push(reaction);
    return acc;
  }, {} as Record<number, string[]>);
}

/**
 * Helper: Fetch image meta data
 */
async function fetchImageMeta(
  ctx: FeedContext<'Image'>,
  imageIds: number[]
): Promise<Record<number, { meta: any }>> {
  const results = await ctx.pg.query<{ id: number; meta: any }>(`
    SELECT id, meta
    FROM "Image"
    WHERE id = ANY($1) AND meta IS NOT NULL
  `, [imageIds]);

  return results.reduce((acc, row) => {
    acc[row.id] = { meta: row.meta };
    return acc;
  }, {} as Record<number, { meta: any }>);
}

/**
 * Helper: Fetch video metadata
 */
async function fetchVideoMetadata(
  ctx: FeedContext<'Image'>,
  videoIds: number[]
): Promise<Record<number, { metadata: any }>> {
  if (videoIds.length === 0) return {};

  const results = await ctx.pg.query<{ id: number; metadata: any }>(`
    SELECT id, metadata
    FROM "Image"
    WHERE id = ANY($1) AND type = 'video'
  `, [videoIds]);

  return results.reduce((acc, row) => {
    acc[row.id] = { metadata: row.metadata };
    return acc;
  }, {} as Record<number, { metadata: any }>);
}

/**
 * Helper: Fetch video thumbnails
 * Thumbnails are stored as Image records with parentId in metadata
 */
async function fetchVideoThumbnails(
  ctx: FeedContext<'Image'>,
  videoIds: number[]
): Promise<Record<number, { url: string; nsfwLevel: number }>> {
  if (videoIds.length === 0) return {};

  // First, get thumbnail IDs from video metadata
  const targets = await ctx.pg.query<{ imageId: number; thumbnailId: number }>(`
    SELECT
      id as "imageId",
      cast(metadata->'thumbnailId' as int) as "thumbnailId"
    FROM "Image"
    WHERE id = ANY($1) AND type = 'video'
  `, [videoIds]);

  const thumbnailIds = targets
    .map((x) => x.thumbnailId)
    .filter((id): id is number => id != null);

  if (thumbnailIds.length === 0) return {};

  // Fetch thumbnail images
  const thumbnails = await ctx.pg.query<{
    id: number;
    url: string;
    nsfwLevel: number;
    parentId: number;
  }>(`
    SELECT
      id,
      url,
      "nsfwLevel",
      cast(metadata->'parentId' as int) as "parentId"
    FROM "Image"
    WHERE id = ANY($1)
  `, [thumbnailIds]);

  // Map by parentId (which is the video ID)
  return thumbnails.reduce((acc, row) => {
    if (row.parentId) {
      acc[row.parentId] = { url: row.url, nsfwLevel: row.nsfwLevel };
    }
    return acc;
  }, {} as Record<number, { url: string; nsfwLevel: number }>);
}

/**
 * Helper: Fetch image cosmetics
 * Uses UserCosmetic table with equippedToType = 'Image'
 */
async function fetchImageCosmetics(
  ctx: FeedContext<'Image'>,
  imageIds: number[]
): Promise<Record<number, any>> {
  if (imageIds.length === 0) return {};

  const results = await ctx.pg.query<{
    equippedToId: number;
    cosmeticId: number;
    claimKey: string;
    userData: any;
  }>(`
    SELECT
      "equippedToId",
      "cosmeticId",
      "claimKey",
      data as "userData"
    FROM "UserCosmetic"
    WHERE "equippedToId" = ANY($1) AND "equippedToType" = 'Image'::"CosmeticEntity"
  `, [imageIds]);

  if (results.length === 0) return {};

  // Fetch cosmetic details
  const cosmeticIds = results.map(r => r.cosmeticId);
  const cosmeticsData = await ctx.cache.fetch('cosmeticData', cosmeticIds);

  return results.reduce((acc, row) => {
    const cosmetic = cosmeticsData[row.cosmeticId];
    if (cosmetic) {
      acc[row.equippedToId] = {
        id: cosmetic.id,
        name: cosmetic.name,
        type: cosmetic.type,
        data: cosmetic.data,
        source: cosmetic.source,
        claimKey: row.claimKey,
      };
    }
    return acc;
  }, {} as Record<number, any>);
}

/**
 * Populate documents with additional data
 * Replicates the logic from getAllImagesIndex
 * Includes post-filtering, metrics, user data, reactions, tags, cosmetics
 */
async function populateDocuments(
  ctx: FeedContext<'Image'>,
  documents: ImageDocument[],
  input: ImageQueryInput
): Promise<PopulatedImage[]> {
  console.log('[ImageFeed:populateDocuments] Starting with', documents.length, 'documents');

  if (documents.length === 0) return [];

  const { currentUserId, isModerator, include = [] } = input;
  const snappedNow = snapToInterval(Date.now());

  // Step 1: Apply post-filtering (matches getImagesFromSearchPostFilter logic)
  console.log('[ImageFeed:populateDocuments] Applying post-filtering...');
  const filteredDocs = documents.filter((doc) => {
    // Check for valid data
    if (!doc.url) return false;

    const isOwnContent = (currentUserId && doc.userId === currentUserId) || isModerator;

    // Private content check
    if (doc.availability === 'Private' && !isOwnContent) return false;

    // Blocked content check
    if (doc.blockedFor && !isOwnContent) return false;

    // Scheduled/unpublished check
    if ((!doc.publishedAtUnix || doc.publishedAtUnix > snappedNow) && !isOwnContent)
      return false;

    // Unscanned content check (nsfwLevel === 0)
    if (doc.nsfwLevel === 0 && !isOwnContent) return false;

    // Minor content check
    if (doc.acceptableMinor) return isOwnContent;

    // Review check
    if (![0, NsfwLevel.Blocked].includes(doc.nsfwLevel) && !doc.needsReview) return true;

    return isOwnContent || (isModerator && includesNsfwContent(input.browsingLevel || 1));
  });

  console.log('[ImageFeed:populateDocuments] After filtering:', filteredDocs.length, 'documents remain');

  if (filteredDocs.length === 0) return [];

  // Step 2: Existence checking (feature-flagged)
  let existenceFilteredDocs = filteredDocs;

  console.log('[ImageFeed:populateDocuments] Existence checking available');

  // Check if existence checking is enabled (passed from caller)
  const cacheExistenceEnabled = input.enableExistenceCheck ?? false;
  console.log('[ImageFeed:populateDocuments] Cache existence enabled:', cacheExistenceEnabled);

  const imageIdsForExistence = filteredDocs.map((d) => d.id);

  if (!cacheExistenceEnabled) {
    // BASIC DB CHECK (default)
    console.log('[ImageFeed:populateDocuments] Using basic DB check');
    const dbIdResp = await ctx.pg.query<{ id: number }>(`
      SELECT id FROM "Image" WHERE id = ANY($1)
    `, [imageIdsForExistence]);

    const idSet = new Set(dbIdResp.map((r) => r.id));
    existenceFilteredDocs = filteredDocs.filter((d) => idSet.has(d.id));

    console.log('[ImageFeed:populateDocuments] Basic DB check: dropped', filteredDocs.length - existenceFilteredDocs.length, 'images');
  } else {
    // SMART CACHE EXISTENCE CHECK (feature-flagged)
    console.log('[ImageFeed:populateDocuments] Using smart cache check');
    const uniqueIds = [...new Set(imageIdsForExistence)];
    const cachePrefix = `${FEED_REDIS_KEYS.CACHES.IMAGE_EXISTS}:`;
    const cacheKeys = uniqueIds.map((id) => `${cachePrefix}${id}`);

    // Check cached results first (10 minute TTL)
    const cachedResults = cacheKeys.length > 0 ? await ctx.cache.mGet(cacheKeys) : [];

    // Separate cached and uncached IDs
    const uncachedIds: number[] = [];
    const cachedMap = new Map<number, boolean>();

    for (let i = 0; i < uniqueIds.length; i++) {
      const id = uniqueIds[i];
      const cachedResult = cachedResults[i];

      if (cachedResult === 'true') {
        cachedMap.set(id, true);
      } else if (cachedResult === 'false') {
        cachedMap.set(id, false);
      } else {
        uncachedIds.push(id);
      }
    }

    console.log('[ImageFeed:populateDocuments] Cache stats: cached=', uniqueIds.length - uncachedIds.length, 'uncached=', uncachedIds.length);

    // Query DB for uncached IDs
    if (uncachedIds.length > 0) {
      const dbResults = await ctx.pg.query<{ id: number }>(`
        SELECT id FROM "Image" WHERE id = ANY($1)
      `, [uncachedIds]);

      const dbIdSet = new Set(dbResults.map((r) => r.id));

      // Update cache with DB results (10-minute TTL)
      const cacheUpdates: Record<string, string> = {};
      for (const id of uncachedIds) {
        const exists = dbIdSet.has(id);
        cacheUpdates[`${cachePrefix}${id}`] = exists ? 'true' : 'false';
        cachedMap.set(id, exists);
      }

      await Promise.all(
        Object.entries(cacheUpdates).map(([key, value]) =>
          ctx.cache.set(key, value, { EX: 600 })
        )
      );
    }

    // Filter based on existence
    existenceFilteredDocs = filteredDocs.filter((d) => {
      const exists = cachedMap.get(d.id);
      return exists !== false; // treat undefined as exists=true
    });

    console.log('[ImageFeed:populateDocuments] Smart cache check: dropped', filteredDocs.length - existenceFilteredDocs.length, 'images');
  }

  if (existenceFilteredDocs.length === 0) return [];

  // Step 3: Extract IDs for data fetching
  const imageIds = existenceFilteredDocs.map((d) => d.id);
  const videoIds = existenceFilteredDocs.filter((d) => d.type === 'video').map((d) => d.id);
  const userIds = [...new Set(existenceFilteredDocs.map((d) => d.userId))];

  console.log('[ImageFeed:populateDocuments] Fetching data for', imageIds.length, 'images,', videoIds.length, 'videos,', userIds.length, 'users');

  // Step 4: Fetch user reactions (if authenticated)
  let userReactions: Record<number, string[]> = {};
  if (currentUserId) {
    console.log('[ImageFeed:populateDocuments] Fetching user reactions...');
    userReactions = await fetchUserReactions(ctx, imageIds, currentUserId);
  }

  // Step 5: Fetch all required data in parallel
  console.log('[ImageFeed:populateDocuments] Fetching all data in parallel...');
  const includeTags = include.includes('tags');
  const includeTagIds = include.includes('tagIds');
  const shouldFetchTags = includeTags || includeTagIds;

  // Fetch data in parallel with proper typing for conditional fetches
  type ProfilePictureData = Awaited<ReturnType<typeof ctx.cache.fetch<'profilePictures'>>>;
  type UserCosmeticData = Awaited<ReturnType<typeof ctx.cache.fetch<'userCosmetics'>>>;
  type ImageTagIdsData = Awaited<ReturnType<typeof ctx.cache.fetch<'imageTagIds'>>>;
  type TagDataType = Awaited<ReturnType<typeof ctx.cache.fetch<'tagData'>>>;
  type CosmeticDataType = Awaited<ReturnType<typeof ctx.cache.fetch<'cosmeticData'>>>;
  type ImageMetaData = Record<number, { meta: unknown }>;
  type ImageCosmeticsData = Record<number, unknown>;

  const [
    metricsData,
    usersData,
    profilePicturesData,
    userCosmeticsData,
    imageCosmeticsData,
    imageMetaData,
    videoMetadataData,
    videoThumbnailsData,
    imageTagIdsData,
  ] = await Promise.all([
    ctx.metric.fetch(imageIds),
    ctx.cache.fetch('userData', userIds),
    include.includes('profilePictures')
      ? ctx.cache.fetch('profilePictures', userIds)
      : (Promise.resolve({}) as Promise<ProfilePictureData>),
    include.includes('cosmetics')
      ? ctx.cache.fetch('userCosmetics', userIds)
      : (Promise.resolve({}) as Promise<UserCosmeticData>),
    include.includes('cosmetics')
      ? fetchImageCosmetics(ctx, imageIds)
      : (Promise.resolve({}) as Promise<ImageCosmeticsData>),
    include.includes('metaSelect')
      ? fetchImageMeta(ctx, imageIds)
      : (Promise.resolve({}) as Promise<ImageMetaData>),
    fetchVideoMetadata(ctx, videoIds),
    fetchVideoThumbnails(ctx, videoIds),
    shouldFetchTags
      ? ctx.cache.fetch('imageTagIds', imageIds)
      : (Promise.resolve({}) as Promise<ImageTagIdsData>),
  ]);

  // Step 5: Fetch tag data (only if tags or tagIds requested)
  const allTagIds = shouldFetchTags ? [...new Set(
    Object.values(imageTagIdsData).flatMap((img) =>
      Array.isArray(img?.tags) ? img.tags : []
    )
  )] : [];
  const tagsData: TagDataType = allTagIds.length > 0
    ? await ctx.cache.fetch('tagData', allTagIds)
    : {};

  // Step 6: Fetch cosmetic details for user cosmetics
  const cosmeticIds = [...new Set(
    Object.values(userCosmeticsData).flatMap((uc) =>
      Array.isArray(uc?.cosmetics) ? uc.cosmetics.map((c) => c.cosmeticId) : []
    )
  )];
  const cosmeticsData: CosmeticDataType = cosmeticIds.length > 0
    ? await ctx.cache.fetch('cosmeticData', cosmeticIds)
    : {};

  console.log('[ImageFeed:populateDocuments] Building populated images...');

  // Step 6: Transform to output format (matches getAllImagesIndex)
  const populated: PopulatedImage[] = existenceFilteredDocs.map((doc) => {
    // Metrics and stats
    const metrics = metricsData[doc.id];
    const stats: ImageStats = {
      likeCountAllTime: metrics?.ReactionLike ?? 0,
      heartCountAllTime: metrics?.ReactionHeart ?? 0,
      laughCountAllTime: metrics?.ReactionLaugh ?? 0,
      cryCountAllTime: metrics?.ReactionCry ?? 0,
      dislikeCountAllTime: 0,
      commentCountAllTime: metrics?.Comment ?? 0,
      collectedCountAllTime: metrics?.Collection ?? 0,
      tippedAmountCountAllTime: metrics?.Buzz ?? 0,
      viewCountAllTime: 0,
    };

    // User data
    const userData = usersData[doc.userId] ?? {};
    const userCosmetics = userCosmeticsData[doc.userId];
    const userCosmeticsArray = userCosmetics && Array.isArray(userCosmetics.cosmetics)
      ? userCosmetics.cosmetics.map((uc) => {
          const cosmetic = cosmeticsData[uc.cosmeticId];
          return cosmetic
            ? {
                id: cosmetic.id,
                name: cosmetic.name,
                type: cosmetic.type,
                data: cosmetic.data,
                source: cosmetic.source,
                userData: uc.data,
              }
            : null;
        }).filter((c): c is NonNullable<typeof c> => c !== null)
      : [];

    const user = {
      id: doc.userId,
      username: userData.username ?? 'unknown',
      image: userData.image ?? null,
      deletedAt: userData.deletedAt ?? null,
      cosmetics: userCosmeticsArray,
      profilePicture: profilePicturesData[doc.userId] ?? null,
    };

    // Reactions
    const reactions = userReactions[doc.id]?.map((r) => ({
      userId: currentUserId!,
      reaction: r,
    })) ?? [];

    // Tags (only if 'tags' in include, otherwise empty array like getAllImagesIndex)
    const imageTags = includeTags ? imageTagIdsData[doc.id] : null;
    const tags = includeTags && imageTags && Array.isArray(imageTags.tags)
      ? imageTags.tags.map((tagId) => {
          const tag = tagsData[tagId];
          return tag
            ? {
                id: tag.id,
                name: tag.name,
                type: tag.type,
                nsfwLevel: tag.nsfwLevel as NsfwLevel,
              }
            : null;
        }).filter((t): t is NonNullable<typeof t> => t !== null)
      : [];

    // Video data
    const meta = imageMetaData[doc.id]?.meta ?? null;
    const videoMetadata = videoMetadataData[doc.id]?.metadata ?? null;
    const thumbnail = videoThumbnailsData[doc.id] ?? null;

    // Calculate final nsfwLevel from thumbnail (matches getAllImagesIndex)
    const finalNsfwLevel = Math.max(thumbnail?.nsfwLevel ?? 0, doc.nsfwLevel);

    // Image cosmetic
    const cosmetic = imageCosmeticsData[doc.id] ?? null;

    // Build final populated image (matches getAllImagesIndex output)
    const { postedToId, publishedAtUnix, ...docWithoutPostedTo } = doc;

    return {
      ...docWithoutPostedTo,

      // Stats
      stats,

      // User
      user,

      // Reactions
      reactions,

      // Tags
      tags,

      // Image cosmetic
      cosmetic,

      // Transformed fields
      modelVersionId: postedToId,
      type: doc.type as any, // MediaType
      createdAt: doc.sortAt,
      publishedAt: publishedAtUnix ? doc.sortAt : undefined,
      metadata: {
        ...videoMetadata,
        width: doc.width,
        height: doc.height,
      },

      // Additional getAllImagesIndex fields
      availability: doc.availability as Availability, // Availability enum
      name: null,
      scannedAt: null,
      mimeType: null,
      ingestion: finalNsfwLevel === NsfwLevel.Blocked
        ? 'Blocked' as const
        : finalNsfwLevel === 0
        ? 'NotFound' as const
        : 'Scanned' as const,
      postTitle: null,
      meta,
      nsfwLevel: finalNsfwLevel,
      thumbnailUrl: thumbnail?.url,
    };
  });

  // Step 7: Track seen images
  if (populated.length > 0) {
    console.log('[ImageFeed:populateDocuments] Tracking', populated.length, 'seen images');
    try {
      await ctx.cache.sAdd(
        FEED_REDIS_KEYS.QUEUES.SEEN_IMAGES,
        populated.map((i) => i.id)
      );
    } catch (err) {
      console.error('[ImageFeed:populateDocuments] Error tracking seen images:', err);
    }
  }

  console.log('[ImageFeed:populateDocuments] Completed, returning', populated.length, 'populated images');
  return populated;
}

// ============================================================================
// Export Feed
// ============================================================================

export const ImagesFeed = createFeed({
  entityType: 'Image' as const,
  name: 'metrics_images_v1',
  connection: {
    host: process.env.FEED_IMAGE_HOST,
    apiKey: process.env.FEED_IMAGE_API_KEY,
  },
  schema,
  createDocuments,
  queryDocuments,
  populateDocuments,
  // Return just sortAtUnix - base.ts will combine with offset as "offset|sortAtUnix"
  getCursor: (doc) => String(doc.sortAtUnix),
});
