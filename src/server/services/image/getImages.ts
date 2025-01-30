import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { CacheTTL } from '~/server/common/constants';
import { ImageSort, NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { getPeriods } from '~/server/utils/enum-helpers';
import {
  Availability,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';

// TODO do we need this file?

type ImageModel = {
  id: number;
  createdAt: Date;
  name?: string;
  url: string;
  hash?: string;
  height: number;
  width: number;
  type: MediaType;
  metadata: Record<string, unknown>;
  nsfwLevel: NsfwLevel;
  generationProcess?: ImageGenerationProcess;
  postId?: number;
  needsReview?: string;
  mimeType?: string;
  ingestion: ImageIngestionStatus;
  hasMeta: boolean;
  onSite: boolean;
  remixOfId?: number | null;
};

type WithTagIds<T> = T & { tagIds?: number[] };
type Stats = {
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
  collectedCount: number;
  viewCount: number;
  tippedAmount: number;
};

type Post = {
  publishedAt?: Date;
  unpublishedAt?: Date;
  availability: Availability;
  modelVersionId?: number;
};

const imageSelect = Prisma.sql`
    i.id,
    i."createdAt",
    i.name,
    i.url,
    i."nsfwLevel",
    i.width,
    i.height,
    i.hash,
    i."generationProcess",
    i."mimeType",
    i.type,
    i.metadata,
    i.ingestion,
    i."needsReview",
    i."userId",
    i."postId",
    i."hideMeta",
    (
      CASE
        WHEN i.meta IS NOT NULL AND NOT i."hideMeta"
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
        WHEN i.meta->>'civitaiResources' IS NOT NULL
        THEN TRUE
        ELSE FALSE
      END
    ) as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId"
  `;

const imageMetricsJoin = Prisma.sql`"ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"`;
const imageMetricsSelect = Prisma.sql`
    COALESCE(im."cryCount", 0) "cryCount",
    COALESCE(im."laughCount", 0) "laughCount",
    COALESCE(im."likeCount", 0) "likeCount",
    COALESCE(im."dislikeCount", 0) "dislikeCount",
    COALESCE(im."heartCount", 0) "heartCount",
    COALESCE(im."commentCount", 0) "commentCount",
    COALESCE(im."tippedAmountCount", 0) "tippedAmount",
    COALESCE(im."viewCount", 0) "viewCount"
  `;

/** "Post" accessor: `p."..."` */
const postJoin = Prisma.sql`"Post" p ON p.id = i."postId"`;
const postSelect = Prisma.sql`
    p."publishedAt",
    p.metadata->>'unpublishedAt' "unpublishedAt",
    p."modelVersionId",
    p."availability"
  `;

type GetImagesParams = {
  withImageMetrics?: boolean;
  withImageResource?: boolean;
  withPost?: boolean;
  withMeta?: boolean;
  explain?: boolean;
  count?: boolean;
  join?: Prisma.Sql[];
  and?: Prisma.Sql[];
  select?: Prisma.Sql[];
  user?: SessionUser;
  query: {
    // common
    limit: number;
    sort: ImageSort;
    period: MetricTimeframe;
    periodMode: 'stats' | 'published';
    skip?: number;
    cursor?: string | number | bigint | Date;
    // query props
    browsingLevel: number;
    userId?: number;
    hidden?: boolean;
    imageIds?: number[];
    postId?: number;
    modelId?: number;
    modelVersionId?: number;
    reviewId?: number;
    prioritizedUserId?: number;
    /** allow retrieval of images that haven't been ingested yet */
    pending?: boolean;
    fromPlatform?: boolean;
    notPublished?: boolean;
    hasMeta?: boolean;
    types?: Array<'image' | 'video' | 'audio'>;
    followed?: boolean;
    generation?: Array<'txt2img' | 'txt2imgHiRes' | 'img2img' | 'inpainting'>;
    postIds?: number[];
  };
};

/**
 * Available accessors:
 * - "Image" i
 * - "Post" p
 * - "ImageMetric" im
 * - "ImageResource" irr
 */
export async function queryImages({
  withImageMetrics,
  withImageResource,
  withPost,
  withMeta,
  explain,
  count,
  join = [],
  and = [],
  select = [],
  query,
  user,
}: GetImagesParams) {
  // #region [variables]
  const {
    // common
    limit,
    sort,
    period,
    periodMode,
    skip,
    cursor,
    // query props
    browsingLevel,
    userId,
    hidden,
    imageIds,
    postId,
    modelId,
    modelVersionId,
    reviewId,
    prioritizedUserId,
    pending,
    fromPlatform,
    notPublished,
    hasMeta,
    types,
    followed,
    generation,
    postIds,
  } = query;

  const cacheTags: string[] = [];
  let cacheTime = CacheTTL.xs;
  let orderBy: string;
  const SELECT = [imageSelect];
  const JOIN: Prisma.Sql[] = [];
  const AND: Prisma.Sql[] = [];

  const requireImageResource = !prioritizedUserId && (reviewId || modelId || modelVersionId);
  if (requireImageResource) withImageResource = true;
  // #endregion

  // #region [error handling]
  if (cursor && skip) throw new Error('Cannot use skip with cursor');
  // #endregion

  // #region [from/join setup]
  if (withImageResource) {
    JOIN.push(Prisma.sql`FROM "ImageResource" irr JOIN "Image" i ON i.id = irr."imageId"`);
  } else {
    JOIN.push(Prisma.sql`FROM "Image" i`);
  }
  // #endregion

  // #region [userId query]
  if (userId) {
    AND.push(Prisma.sql`i."userId" = ${userId}`);
    if (userId !== user?.id) {
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-user:${userId}`);
    } else cacheTime = 0;
  }
  // #endregion

  // #region [browsingLevel]
  if (pending && user) {
    if (user.isModerator) {
      AND.push(Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`);
    } else {
      AND.push(Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${user.id})`);
      AND.push(
        Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${user.id}))`
      );
    }
  } else {
    AND.push(Prisma.sql`i."needsReview" IS NULL`);
    AND.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0 AND i."nsfwLevel" != 0`
        : Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }
  // #endregion

  // #region [order by]
  if (postId && !modelId) {
    // a post image query won't include modelId
    orderBy = `i."index"`;
  } else {
    const isGallery = modelId || modelVersionId || reviewId || userId;
    withImageMetrics = true;
    // Sort by selected sort
    if (sort === ImageSort.MostComments) {
      orderBy = `im."commentCount" DESC, im."reactionCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."commentCount" > 0`);
    } else if (sort === ImageSort.MostReactions) {
      orderBy = `im."reactionCount" DESC, im."heartCount" DESC, im."likeCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."reactionCount" > 0`);
    } else if (sort === ImageSort.MostCollected) {
      orderBy = `im."collectedCount" DESC, im."reactionCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."collectedCount" > 0`);
    }

    // else if (sort === ImageSort.Random) orderBy = 'ct."randomId" DESC'; // TODO - support this?
    else if (sort === ImageSort.Oldest) orderBy = `i."createdAt" ASC`;
    else {
      if (withImageResource) {
        // Ensure to sort by irr.imageId when reading from imageResources to maximize index utilization
        orderBy = `irr."imageId" DESC`;
      } else {
        orderBy = `i."id" DESC`;
      }
    }
  }

  // Limit to images created since period start
  const sortingByMetrics = orderBy.includes('im.');
  if (sortingByMetrics && period !== 'AllTime' && periodMode !== 'stats') {
    withImageMetrics = true;
    const ageGroups = getPeriods(period);
    AND.push(
      Prisma.sql`im."ageGroup" = ANY(ARRAY[${Prisma.join(ageGroups)}]::"MetricTimeframe"[])`
    );
  } else if (period && period !== 'AllTime' && periodMode !== 'stats') {
    const interval = period.toLowerCase();
    AND.push(
      Prisma.sql`i."createdAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(interval)}'`
    );
  }
  // #endregion

  // #region [prioritizedUserId]
  if (prioritizedUserId) {
    if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');
    if (modelVersionId) {
      withPost = true;
      AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
    }

    // If system user, show community images
    if (prioritizedUserId === -1)
      orderBy = `IIF(i."userId" = ${prioritizedUserId}, i.index, 1000),  ${orderBy}`;
    else {
      // For everyone else, only show their images.
      AND.push(Prisma.sql`i."userId" = ${prioritizedUserId}`);
      orderBy = `(i."postId" * 100) + i."index"`; // Order by oldest post first
    }
  }
  // #endregion

  // #region [followed user images]
  if (user && followed) {
    const followedUsers = await dbRead.userEngagement.findMany({
      where: { userId, type: 'Follow' },
      select: { targetUserId: true },
    });
    const userIds = followedUsers.map((x) => x.targetUserId);
    if (userIds.length) {
      cacheTime = 0;
      AND.push(Prisma.sql`i."userId" IN (${Prisma.join(userIds)})`);
    }
  }
  // #endregion

  // #region [general queries]
  if (postId) AND.push(Prisma.sql`i."postId" = ${postId}`);
  if (!!postIds?.length) AND.push(Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`);
  if (fromPlatform) AND.push(Prisma.sql`(i.meta IS NOT NULL AND i.meta ? 'civitaiResources')`);
  if (notPublished && user?.isModerator) {
    withPost = true;
    AND.push(Prisma.sql`(p."publishedAt" IS NULL)`);
  }
  if (hasMeta) AND.push(Prisma.sql`i.meta IS NOT NULL AND NOT i."hideMeta"`);
  if (!!types?.length)
    AND.push(Prisma.sql`i.type = ANY(ARRAY[${Prisma.join(types)}]::"MediaType"[])`);
  if (!!imageIds?.length) AND.push(Prisma.sql`i."id" IN (${Prisma.join(imageIds)})`);
  if (!!generation?.length)
    AND.push(Prisma.sql`i."generationProcess" IN (${Prisma.join(generation)})`);

  // #endregion

  // #region [joins]
  if (withPost) {
    SELECT.push(postSelect);
    JOIN.push(postJoin);
    AND.push(Prisma.sql`i."postId" IS NOT NULL`);
  }

  if (requireImageResource) {
    if (reviewId) {
      JOIN.push(
        Prisma.sql`"ResourceReview" resourceReview ON resourceReview."modelVersionId" = irr."modelVersionId"`
      );
      AND.push(Prisma.sql`resourceReview."id" = ${reviewId}`);
      cacheTime = 0;
    } else if (modelVersionId) {
      AND.push(Prisma.sql`irr."modelVersionId" = ${modelVersionId}`);
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-modelVersion:${modelVersionId}`);
    } else if (modelId) {
      JOIN.push(Prisma.sql`"ModelVersion" mv ON mv.id = irr."modelVersionId"`);
      AND.push(Prisma.sql`mv."modelId" = ${modelId}`);
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-model:${modelId}`);
    }
  }

  if (withImageMetrics) {
    SELECT.push(imageMetricsSelect);
    JOIN.push(imageMetricsJoin);
  }
  // #endregion

  const prismaQuery = Prisma.sql`
    SELECT
      ${count ? Prisma.sql`COUNT(*)` : Prisma.join([...SELECT, ...select], ',\n  ')}
      FROM "Image" i
      ${Prisma.join([...JOIN, ...join], '\n  ')}
      ${[...AND, ...and].length ? `WHERE ${Prisma.join([...AND, ...and], '\n  AND ')}` : ''}
      LIMIT ${limit + 1}
  `;

  const { rows: rawImages } = await pgDbRead.query<ImageModel & Stats & Post>(prismaQuery);
  const queriedImageIds = rawImages.map((i) => i.id);

  // always return tagIds for as long as we are doing front end filtering
  const tagIdsDictionary = await tagIdsForImagesCache.fetch(queriedImageIds);
  // TODO - if `withImageMetrics`, then get user reactions

  const images = rawImages.map(
    ({
      cryCount,
      laughCount,
      likeCount,
      dislikeCount,
      heartCount,
      commentCount,
      collectedCount,
      viewCount,
      tippedAmount,
      ...image
    }) => ({
      ...image,
      stats: {
        cryCount,
        laughCount,
        likeCount,
        dislikeCount,
        heartCount,
        commentCount,
        collectedCount,
        viewCount,
        tippedAmount,
      },
      tagIds: tagIdsDictionary[image.id]?.tags,
    })
  );

  return {
    items: images,
  };
}
