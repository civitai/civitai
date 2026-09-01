import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { isImageMetaOnSite } from '~/server/utils/image-onsite';
import { env } from '~/env/server';
import { BlockedReason, PostSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getDbWithoutLag,
  preventReplicationLag,
  preventReplicationLagBatch,
} from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import {
  imageMetaCache,
  imageResourcesCache,
  modelVersionAccessCache,
  postStatCache,
  thumbnailCache,
  imageMetadataCache,
  userBasicCache,
  userImageVideoCountCaches,
  userPostCountCache,
} from '~/server/redis/caches';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type { ImageMetaProps, ImageSchema, IngestImageInput } from '~/server/schema/image.schema';
import { externalMetaSchema } from '~/server/schema/image.schema';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import type { PostImageEditProps, PostImageEditSelect } from '~/server/selectors/post.selector';
import { editPostImageSelect, postSelect } from '~/server/selectors/post.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import {
  buildPostCursorClause,
  encodePostCursor,
  getPostSortClauses,
} from '~/server/services/post-sort';
import { withSpan } from '~/server/utils/otel-helpers';
import {
  getCollectionById,
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { canViewCollectionPost } from '~/server/services/post-collection-visibility';
import {
  createImage,
  createImageResources,
  deleteImageFromS3,
  deleteImagesForModelVersionCache,
  getImagesForPosts,
  imagesForModelVersionsCache,
  enqueueImageIngestion,
  invalidateManyImageExistence,
  purgeImageGenerationDataCache,
  purgeResizeCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { bustImageDeliveryMetadataCache } from '~/server/services/image-delivery.service';
import { findOrCreateTagsByName, getVotableImageTags } from '~/server/services/tag.service';
import { getTechniqueByName } from '~/server/services/technique.service';
import { getToolByAlias, getToolByDomain, getToolByName } from '~/server/services/tool.service';
import type {
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
import { getPeriods } from '~/server/utils/enum-helpers';
import { capPostGetInfiniteImages } from '~/server/utils/post-getinfinite-images';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  Availability,
  CollectionContributorPermission,
  CollectionMode,
  CollectionType,
  MediaType,
  Model3DStatus,
  ModelHashType,
  TagTarget,
  TagType,
} from '~/shared/utils/prisma/enums';
import { isValidAIGeneration } from '~/utils/image-utils';
import type { PreprocessFileReturnType } from '~/utils/media-preprocessors';
import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  resolveVerifiedSourceImageIds,
  sanitizeProvenance,
  storedSourceImageIds,
} from '~/server/services/orchestrator/remix-provenance';
import { getMetadata } from '~/utils/metadata';
import { postgresSlugify } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { CacheTTL, MAX_RESOURCES_PER_IMAGE } from '../common/constants';
import type {
  AddPostTagInput,
  AddResourceToPostImageInput,
  GetPostTagsInput,
  PostCreateInput,
  PostsQueryInput,
  PostUpdateInput,
  RemovePostTagInput,
  RemoveResourceFromPostImageInput,
  ReorderPostImagesInput,
  UpdatePostCollectionTagIdInput,
  UpdatePostImageInput,
} from './../schema/post.schema';

type GetAllPostsRaw = {
  id: number;
  nsfwLevel: number;
  title: string | null;
  userId: number;
  publishedAt: Date | null;
  cursorId: Date | number | null;
  modelVersionId: number | null;
  collectionId: number | null;
  detail?: string | null;
  stats?: {
    commentCount: number;
    likeCount: number;
    dislikeCount: number;
    heartCount: number;
    laughCount: number;
    cryCount: number;
    collectedCount: number;
  } | null;
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
};
export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];

const getPostStatsObject = async (data: { id: number }[]) => {
  try {
    return await postStatCache.fetch(data.map((d) => d.id));
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to getPostStats',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'civitai-prod'
    );
    return {};
  }
};

/**
 * Frontend References:
 * - limit: All consumers (pagination)
 * - cursor: All consumers (infinite scroll pagination)
 * - query: src/components/Post/post.utils.ts:27 (postQueryParamSchema) - not currently exposed in UI
 * - username: src/pages/user/[username]/posts.tsx:90, src/components/Post/post.utils.ts:33, src/components/ResourceReview/ResourceReviewDetail.tsx:46
 * - excludedImageIds: Internal use only (hidden preferences)
 * - excludedUserIds: Internal use only (hidden preferences)
 * - period: src/pages/user/[username]/posts.tsx:42,90, src/components/Post/post.utils.ts:35, src/components/Post/Infinite/PostsInfinite.tsx:22, src/components/Collections/Collection.tsx:368,383,388
 * - periodMode: Internal use only
 * - sort: src/pages/user/[username]/posts.tsx:43,90, src/components/Post/post.utils.ts:36, src/components/Post/Infinite/PostsInfinite.tsx:23, src/components/Collections/Collection.tsx:370-372,382,389, src/components/ResourceReview/ResourceReviewDetail.tsx:48
 * - user: Internal (session user from context)
 * - tags: src/components/Post/post.utils.ts:30, src/components/Post/Infinite/PostsInfinite.tsx:20, src/components/Collections/Collection.tsx:378
 * - modelVersionId: src/components/ResourceReview/ResourceReviewDetail.tsx:47, src/components/Post/post.utils.ts:32, src/components/Post/Infinite/PostsInfinite.tsx:19, src/components/Collections/Collection.tsx:377
 * - ids: src/server/services/collection.service.ts:1347 (internal server-side use only)
 * - collectionId: src/components/Post/post.utils.ts:37, src/components/Post/Infinite/PostsInfinite.tsx:24, src/components/Collections/Collection.tsx:384,390
 * - include: Internal use (cosmetics, detail)
 * - draftOnly: src/pages/user/[username]/posts.tsx:90, src/components/Post/Infinite/PostsInfinite.tsx:25, src/components/Collections/Collection.tsx:380,391
 * - followed: src/pages/user/[username]/posts.tsx:90, src/components/Post/post.utils.ts:39, src/components/Collections/Collection.tsx:381,391
 * - browsingLevel: src/components/Post/post.utils.ts:24,49,61, src/components/ResourceReview/ResourceReviewDetail.tsx:43,49
 * - pending: src/pages/user/[username]/posts.tsx:90, src/components/Post/Infinite/PostsInfinite.tsx:27
 * - excludedTagIds: src/components/Post/post.utils.ts:51-56,62 (from browsing settings addons)
 * - disablePoi: src/components/Post/post.utils.ts:63 (from browsing settings addons)
 * - disableMinor: src/components/Post/post.utils.ts:64 (from browsing settings addons)
 * - poiOnly: Mod-only filter - not exposed to frontend
 * - minorOnly: Mod-only filter - not exposed to frontend
 */
/**
 * Who may see a creator's unpublished posts: the creator themselves, or a
 * moderator viewing a SPECIFIC creator's profile.
 *
 * 🔴 `targetUser` is the authorization, not decoration. Without it a moderator
 * on the global posts feed takes the owner branch and receives every draft on
 * the site.
 *
 * ⚠️ This is STRICTER than `canRequestUnpublished` in `image.service.ts`, and
 * the divergence is real rather than an oversight: that one returns true for a
 * moderator before looking at the scope at all, so an unscoped moderator request
 * is refused here and granted there. Recorded because the two are otherwise the
 * same shape and a reader reconciling them will assume they agree. If they are
 * ever unified, this is the direction to unify towards — the images side has no
 * test for the unscoped-moderator case, so nothing there is pinning that
 * behaviour deliberately.
 *
 * Extracted so it can be tested without a database, and kept deliberately apart
 * from `isOwnerRequest`, which also gates the `tags` and `query` filters.
 * Widening that instead would silently drop tag and title filtering for
 * moderators.
 */
export function canSeePostDrafts({
  isOwnerRequest,
  isModerator,
  targetUser,
}: {
  isOwnerRequest: boolean;
  isModerator: boolean;
  targetUser?: number | null;
}) {
  return isOwnerRequest || (isModerator && !!targetUser);
}

export const getPostsInfinite = async ({
  limit,
  cursor,
  query,
  username,
  excludedImageIds,
  excludedUserIds,
  period,
  periodMode,
  sort,
  user,
  tags,
  modelVersionId,
  ids,
  collectionId,
  include,
  draftOnly,
  scheduled,
  followed,
  browsingLevel,
  pending,
  excludedTagIds,
  disablePoi,
  disableMinor,
  poiOnly,
  minorOnly,
}: Omit<PostsQueryInput, 'include'> & {
  user?: SessionUser;
  include?: string[];
}) => {
  const AND = [Prisma.sql`1 = 1`];
  const cacheTags: string[] = [];
  let cacheTime = CacheTTL.xs;
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;
  const includeCosmetics = !!include?.includes('cosmetics');

  const isOwnerRequest =
    !!user?.username && !!username && postgresSlugify(user.username) === postgresSlugify(username);

  let targetUser: number | undefined;

  if (username) {
    const record = await dbRead.user.findFirst({ where: { username }, select: { id: true } });

    if (record) {
      targetUser = record.id;
      AND.push(Prisma.sql`p."userId" = ${targetUser}`);
      cacheTags.push(`posts-user:${targetUser}`);
    }
  }

  if (!isOwnerRequest && !isModerator) {
    // Makes it so private posts are not shown to the public
    AND.push(Prisma.sql`p."availability" != 'Private'`);
  }

  // Filter only followed users
  if (!!user && followed) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: user.id },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });

    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];
    AND.push(
      Prisma.sql`p."userId" IN (${
        followedUsersIds.length > 0 ? Prisma.join(followedUsersIds) : null
      })`
    );
  }

  if (modelVersionId) {
    AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
    cacheTags.push(`posts-modelVersion:${modelVersionId}`);
  }

  const canSeeUnpublished = canSeePostDrafts({ isOwnerRequest, isModerator, targetUser });

  let collectionJoined = false;
  let collectionJoin = Prisma.empty;
  if (!canSeeUnpublished) {
    if (scheduled && userId) {
      // Surface own scheduled posts alongside the public published feed. Mirrors
      // the image service carve-out (image.service.ts ~line 4060).
      AND.push(
        Prisma.sql`(p."publishedAt" <= NOW() OR (p."userId" = ${userId} AND p."publishedAt" > NOW()))`
      );
    } else {
      AND.push(Prisma.sql`p."publishedAt" <= NOW()`);
    }
  } else {
    if (draftOnly) {
      if (scheduled) AND.push(Prisma.sql`(p."publishedAt" IS NULL OR p."publishedAt" > NOW())`);
      else AND.push(Prisma.sql`p."publishedAt" IS NULL`);
    } else if (scheduled) AND.push(Prisma.sql`p."publishedAt" IS NOT NULL`);
    else AND.push(Prisma.sql`p."publishedAt" <= NOW() AND p."publishedAt" IS NOT NULL`);
  }

  // Still keyed on `isOwnerRequest`, NOT on `canSeeUnpublished`. These are
  // discovery filters, not publication ones — an owner browsing their own
  // profile has never had them applied, and folding them into the publication
  // gate above would have silently dropped tag and title filtering for
  // moderators, who do get them today.
  if (!isOwnerRequest) {
    if (!!tags?.length)
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "TagsOnPost" top
        WHERE top."postId" = p.id AND top."tagId" IN (${Prisma.join(tags)})
      )`);

    if (query) {
      AND.push(Prisma.sql`p.title ILIKE ${query + '%'}`);
    }
  }

  if (period !== 'AllTime') {
    const interval = period.toLowerCase();
    if (draftOnly) {
      AND.push(
        Prisma.sql`p."createdAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(interval)}'`
      );
    } else {
      AND.push(
        Prisma.sql`p."publishedAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(
          interval
        )}'`
      );
    }
  }

  if (browsingLevel) {
    if (pending && (isModerator || userId)) {
      if (isModerator) {
        AND.push(Prisma.sql`((p."nsfwLevel" & ${browsingLevel}) != 0 OR p."nsfwLevel" = 0)`);
      } else if (userId) {
        AND.push(
          Prisma.sql`((p."nsfwLevel" & ${browsingLevel}) != 0 OR (p."nsfwLevel" = 0 AND p."userId" = ${userId}))`
        );
      }
    } else {
      AND.push(Prisma.sql`(p."nsfwLevel" & ${browsingLevel}) != 0`);
    }
  }

  if (sort === PostSort.RecentlyAdded && !collectionId) {
    throw throwBadRequestError('Recently Added sort requires a collectionId');
  }

  if (ids) AND.push(Prisma.sql`p.id IN (${Prisma.join(ids)})`);
  if (collectionId) {
    cacheTime = CacheTTL.day;

    const permissions = await getUserCollectionPermissionsById({
      userId: user?.id,
      id: collectionId,
    });

    if (!permissions.read) {
      return { items: [] };
    }

    const displayReviewItems = user?.id
      ? `OR (ci."status" = 'REVIEW' AND ci."addedById" = ${user?.id})`
      : '';

    // A semi-join cannot expose ci."id" to the ORDER BY. Safe to widen: CollectionItem_post_idx is
    // unique on ("collectionId", "postId"), so the join cannot multiply rows. schema.full.prisma
    // does not declare it — it lives in containers/db/docker-init/02_all_dll.sql.
    if (sort === PostSort.RecentlyAdded) {
      const { rawAND: collectionItemAND } = getAvailableCollectionItemsFilterForUser({
        permissions,
        userId: user?.id,
      });
      collectionJoined = true;
      collectionJoin = Prisma.sql`JOIN "CollectionItem" ci
        ON ci."postId" = p.id
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemAND, ' AND ')}`;
    } else {
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."collectionId" = ${collectionId}
          AND ci."postId" = p.id
          AND (ci."status" = 'ACCEPTED' ${Prisma.raw(displayReviewItems)})
      )`);
    }
  }

  if (excludedUserIds && targetUser && excludedUserIds.includes(targetUser)) {
    return { items: [] }; // No need to make the query.
  }

  if (!targetUser && excludedUserIds?.length) {
    // first, make sure these are all numbers:
    const excluded: number[] = excludedUserIds?.map(Number).filter((x) => !isNaN(x)) ?? [];
    AND.push(Prisma.sql`p."userId" NOT IN (${Prisma.raw(`${excluded.join(',')}`)})`);
  }

  // Every sort carries a p.id tiebreaker except Recently Added, whose ci."id" is already unique
  // per row through the ("collectionId", "postId") join.
  const { orderBy, primarySortProp, isDateSort, ascending, filter, singleColumnCursor } =
    getPostSortClauses({
      sort,
      draftOnly,
      collectionJoined,
    });
  if (filter) AND.push(filter);

  const cursorClause = buildPostCursorClause({
    cursor,
    primarySortProp,
    isDateSort,
    ascending,
    singleColumnCursor,
  });
  if (cursorClause) AND.push(cursorClause);

  const postsRawQuery = Prisma.sql`
    SELECT
      p.id,
      p."nsfwLevel",
      p.title,
      p."userId",
      p."publishedAt",
      p."modelVersionId",
      p."collectionId",
      ${include?.includes('detail') ? Prisma.sql`p."detail",` : Prisma.sql``}
      ${Prisma.raw(primarySortProp)} "cursorId"
    FROM "Post" p
    ${collectionJoin}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit + 1}`;

  if (
    query ||
    isOwnerRequest ||
    (!!user && followed) ||
    !env.POST_QUERY_CACHING ||
    (collectionId && !!user?.id) ||
    // The moderator draft view. Unpublished rows have never entered this cache
    // before — the only path that produced them was the owner one, which already
    // zeroes the TTL — and `posts-user:<id>` is busted nowhere in src, so a post
    // that gets published, deleted or taken down would keep showing in a
    // moderation surface for the 60s TTL. Not a leak (the statement differs from
    // a non-moderator's in both the publication and availability clauses, so the
    // hashed key cannot collide) — just the wrong freshness for the one view
    // whose job is acting on what is there right now. Costs nothing: this is not
    // a hot path.
    (canSeeUnpublished && !isOwnerRequest)
  ) {
    cacheTime = 0;
  }

  const cacheable = queryCache(dbRead, 'getPostsInfinite', 'v1');
  const postsRaw = await cacheable<GetAllPostsRaw[]>(postsRawQuery, {
    ttl: cacheTime,
    tag: cacheTags,
  });

  let nextCursor: string | undefined;
  if (postsRaw.length > limit) {
    const nextItem = postsRaw.pop();
    if (nextItem) nextCursor = encodePostCursor(nextItem, singleColumnCursor);
  }

  // Filter to published model versions:
  const filterByPermissionContent = !isOwnerRequest && !user?.isModerator;
  const modelVersionIds = postsRaw.map((p) => p.modelVersionId).filter(isDefined);
  // Get user data
  const userIds = postsRaw.map((i) => i.userId);
  const [images, postStats, userData, cosmetics, modelVersions] = await withSpan(
    'post:getInfinite:parallelFetch',
    () =>
      Promise.all([
        postsRaw.length
          ? getImagesForPosts({
              postIds: postsRaw.map((x) => x.id),
              // excludedIds: excludedImageIds,
              user,
              browsingLevel,
              pending,
              disablePoi,
              disableMinor,
              poiOnly,
              minorOnly,
            })
          : Promise.resolve([]),
        postsRaw.length > 0
          ? getPostStatsObject(postsRaw)
          : Promise.resolve({} as ReturnType<typeof getPostStatsObject>),
        userBasicCache.fetch(userIds),
        includeCosmetics
          ? getCosmeticsForEntity({ ids: postsRaw.map((p) => p.id), entity: 'Post' })
          : Promise.resolve({} as ReturnType<typeof getCosmeticsForEntity>),
        modelVersionIds.length > 0 && filterByPermissionContent
          ? modelVersionAccessCache.fetch(modelVersionIds)
          : Promise.resolve({} as ReturnType<typeof modelVersionAccessCache.fetch>),
      ])
  );

  // Filter to collections with permissions:
  const collectionIds = postsRaw.map((p) => p.collectionId).filter(isDefined);
  const collections =
    collectionIds.length > 0 && filterByPermissionContent
      ? await dbRead.collection.findMany({
          where: { id: { in: collectionIds } },
          select: {
            id: true,
            read: true,
            contributors: user?.id
              ? { select: { userId: true, permissions: true }, where: { userId: user?.id } }
              : undefined,
          },
        })
      : [];

  return {
    nextCursor,
    items: withSpan('post:getInfinite:transform', () =>
      postsRaw
        // remove unlisted resources the user has no access to:
        .filter((p) => {
          // Allow mods and owners to view all.
          if (user?.isModerator || p.userId === user?.id) return true;

          // Hide posts from unpublished model versions:
          if (p.modelVersionId && modelVersions[p.modelVersionId]?.status !== 'Published') {
            return false;
          }

          // Hide posts from collections the user has no access to:
          if (p.collectionId) {
            const collection = collections.find((x) => x.id === p.collectionId);
            if (!collection) return false;

            if (!canViewCollectionPost(collection)) {
              return false;
            }
          }

          return true;
        })
        // Strip `cursorId` from each item: it's the raw sort-key value selected
        // for keyset pagination (surfaced via the page-level `nextCursor`), NOT
        // a per-item field — no consumer reads `item.cursorId`. Dropping it
        // removes one field (a superjson-typed Date/number node) PER POST.
        .map(({ userId: creatorId, cursorId: _cursorId, ...post }) => {
          const _images = images.filter((x) => x.postId === post.id);
          const { username, image, deletedAt } = userData[creatorId] || {};

          return {
            ...post,
            imageCount: _images.length,
            user: {
              id: creatorId,
              username,
              image,
              deletedAt,
              cosmetics: [] as Awaited<ReturnType<typeof getCosmeticsForUsers>>[string],
              profilePicture: null as
                | Awaited<ReturnType<typeof getProfilePicturesForUsers>>[string]
                | null,
            },
            stats: postStats[post.id] ?? null,
            // Cap the images embedded per post in the browse feed. The post cards
            // render only `images[0]` (cover) + the `imageCount` field above
            // (computed from the FULL list, so the count is unaffected), but
            // `getImagesForPosts` returns the post's ENTIRE image list — a gallery
            // post can carry dozens/hundreds of rows, the dominant contributor to
            // this endpoint's ~1.6 MB payloads serialized synchronously on the
            // event loop. The cap keeps headroom for the client hidden-preferences
            // fall-through (see `post-getinfinite-images.ts`); `.slice` returns a
            // new array so nothing upstream is mutated.
            images: capPostGetInfiniteImages(_images),
            cosmetic: cosmetics[post.id] ?? null,
          };
        })
        .filter((x) => x.imageCount !== 0)
    ),
  };
};

const getPostCollectionCollectionItem = async ({
  postCollectionId,
  postId,
  imageIds,
}: {
  postCollectionId: number;
  postId: number;
  imageIds?: number[];
}) => {
  const collectionItems = await dbRead.collectionItem.findMany({
    where: {
      collectionId: postCollectionId,
      OR: [
        {
          postId,
        },
        {
          imageId: { in: imageIds },
        },
      ],
    },
    select: { tagId: true },
  });

  const [item] = collectionItems;
  if (item) {
    return item;
  }

  return null;
};

export type PostDetail = AsyncReturnType<typeof getPostDetail>;
export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const db = await getDbWithoutLag('post', id);
  const post = await db.post.findFirst({
    where: {
      id,
      OR: user?.isModerator
        ? undefined
        : [
            { userId: user?.id },
            { publishedAt: { lt: new Date() }, nsfwLevel: { not: 0 } },
            // Support judges of a collection to view any post in the collection
            // regardless of NSFW level and published status.
            {
              collectionId: {
                not: null,
              },
              collection: {
                contributors: {
                  some: {
                    userId: user?.id,
                    permissions: {
                      has: CollectionContributorPermission.MANAGE,
                    },
                  },
                },
              },
            },
          ],
    },
    select: postSelect,
  });

  if (!post) throw throwNotFoundError();

  // Only fetch the unpublish-context JOIN when the post is currently
  // unpublished (publishedAt = NULL). Public reads are the hot path and
  // don't need this — default the fields and skip the query. Note: a small
  // set of orphan rows can have `publishedAt != null` AND a `prevPublishedAt`
  // stash (future-scheduled clamp orphans documented in the
  // clamp-publishedat-bumps endpoint); we deliberately don't surface
  // restore-only state for those — they're cleaned out-of-band.
  // Pass the same `db` client used above so the stash JOIN shares
  // `getDbWithoutLag`'s primary-routing right after an unpublish/republish.
  const unpublishContext: PostUnpublishContext = post.publishedAt
    ? {
        wasPublished: false,
        unpublishedAt: null,
        unpublishedBy: null,
        parentModelId: null,
      }
    : await getPostUnpublishContext({ id, db });

  return {
    ...post,
    detail: post.detail,
    tags: post.tags.flatMap((x) => x.tag),
    ...unpublishContext,
  };
};

export type PostDetailEditable = AsyncReturnType<typeof getPostEditDetail>;
export type PostEditImageDetail = PostDetailEditable['images'][number] & { index: number };
export type ResourceHelper = PostEditImageDetail['resourceHelper'][number];

export const getPostEditDetail = async ({ id, user }: GetByIdInput & { user: SessionUser }) => {
  const post = await getPostDetail({ id, user });
  if (post.user.id !== user.id && !user.isModerator) throw throwAuthorizationError();
  const images = await getPostEditImages({ id, user });

  let collectionTagId: null | number = null;
  let collectionItemExists = false;
  if (post.collectionId) {
    // get tag Id for the first item
    const collectionItem = await getPostCollectionCollectionItem({
      postCollectionId: post.collectionId,
      postId: post.id,
      imageIds: images.map((x) => x.id),
    });

    collectionTagId = collectionItem?.tagId ?? null;
    collectionItemExists = !!collectionItem;
  }

  // Unpublish context is already attached by getPostDetail above.
  return { ...post, collectionTagId, images, collectionItemExists };
};

export type PostUnpublishContext = {
  // True when the post carries a `prevPublishedAt` stash — i.e. it was
  // previously public, then unpublished via the parent model/version flow.
  // Drives the restore-only UI in PostEditSidebar: when set, the post
  // cannot be rescheduled, only republished at its original date.
  wasPublished: boolean;
  unpublishedAt: Date | null;
  unpublishedBy: number | null;
  // Surfaced via JOIN so the UI can build a link back to the parent model
  // edit page (where the actual unpublish reason + custom message live).
  // We deliberately don't surface the reason directly on the post —
  // model-level reasons like "insufficient-description" don't always map
  // onto the post itself, so showing them in the post alert is misleading.
  parentModelId: number | null;
};

async function getPostUnpublishContext({
  id,
  db = dbRead,
}: {
  id: number;
  db?: typeof dbRead | typeof dbWrite;
}): Promise<PostUnpublishContext> {
  const rows = await db.$queryRaw<
    {
      metadata: Record<string, unknown> | null;
      modelId: number | null;
    }[]
  >`
    SELECT
      p.metadata                AS "metadata",
      mv."modelId"              AS "modelId"
    FROM "Post" p
    LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    WHERE p.id = ${id}
  `;

  const row = rows[0];
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  const prevPublishedAt = metadata.prevPublishedAt;
  const rawUnpublishedAt = metadata.unpublishedAt;
  const rawUnpublishedBy = metadata.unpublishedBy;

  return {
    wasPublished: !!prevPublishedAt,
    unpublishedAt: typeof rawUnpublishedAt === 'string' ? new Date(rawUnpublishedAt) : null,
    unpublishedBy: typeof rawUnpublishedBy === 'number' ? rawUnpublishedBy : null,
    parentModelId: row?.modelId ?? null,
  };
}

async function combinePostEditImageData(images: PostImageEditSelect[], user: SessionUser) {
  const imageIds = images.map((x) => x.id);
  const _images = images as PostImageEditProps[];
  const tags = await getVotableImageTags({ ids: imageIds, user });
  const thumbnails = await thumbnailCache.fetch(imageIds);

  return _images
    .map((image) => ({
      ...image,
      metadata: image.metadata as PreprocessFileReturnType['metadata'],
      tags: tags.filter((x) => x.imageId === image.id),
      tools: image.tools.map(({ notes, tool }) => ({ ...tool, notes })),
      techniques: image.techniques.map(({ notes, technique }) => ({ ...technique, notes })),
      thumbnailUrl: thumbnails[image.id]?.url as string | null, // Need to explicit type cast cause ts is trying to be smarter than it should be
    }))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

export type PostImageEditable = AsyncReturnType<typeof getPostEditImages>[number];
export const getPostEditImages = async ({ id, user }: GetByIdInput & { user: SessionUser }) => {
  const db = await getDbWithoutLag('postImages', id);
  const images = await db.image.findMany({
    where: { postId: id },
    select: editPostImageSelect,
  });
  return combinePostEditImageData(images, user);
};

export const createPost = async ({
  userId,
  tag,
  tags,
  ...data
}: PostCreateInput & {
  userId: number;
}): Promise<PostDetailEditable> => {
  await throwOnBlockedUserContent([data.title, data.detail], { surface: 'post' });

  const tagsToAdd: number[] = [];
  if (tags && tags.length > 0) {
    const tagObj = await findOrCreateTagsByName(tags);
    Object.values(tagObj).forEach((t) => {
      if (t !== undefined) tagsToAdd.push(t);
    });
  }
  if (tag) {
    tagsToAdd.push(tag);
  }
  const tagData = tagsToAdd.map((t) => ({ tagId: t }));

  let availability: Availability = Availability.Public;

  if (data.modelVersionId) {
    const modelVersion = await dbWrite.modelVersion.findUnique({
      where: { id: data.modelVersionId },
      select: { model: { select: { availability: true } } },
    });

    availability = modelVersion?.model.availability ?? Availability.Public;
  }

  // Anyone can post to any published 3D model (mirrors Models). Non-owners are
  // still blocked from attaching to a draft/unpublished/deleted 3D model so a
  // queue-card draft can't be hijacked before its owner ships it.
  if (data.model3dId) {
    const model3d = await dbWrite.model3D.findUnique({
      where: { id: data.model3dId },
      select: { id: true, userId: true, status: true, deletedAt: true },
    });
    if (!model3d || model3d.deletedAt) {
      throw throwNotFoundError(`No 3D model with id ${data.model3dId}`);
    }
    const isOwner = model3d.userId === userId;
    if (!isOwner && model3d.status !== Model3DStatus.Published) {
      throw throwAuthorizationError('This 3D model is not available for posting.');
    }
  }

  const post = await dbWrite.post.create({
    data: {
      ...data,
      availability,
      userId,
      tags: tagsToAdd.length > 0 ? { create: tagData } : undefined,
    },
    select: postSelect,
  });

  await preventReplicationLag('post', post.id);
  await userPostCountCache.refresh(userId);

  let collectionTagId: null | number = null;
  let collectionItemExists = false;
  if (post.collectionId) {
    // get tag Id for the first item
    const collectionItem = await getPostCollectionCollectionItem({
      postCollectionId: post.collectionId,
      postId: post.id,
      imageIds: [],
    });

    collectionTagId = collectionItem?.tagId ?? null;
    collectionItemExists = !!collectionItem;
  }

  return {
    ...post,
    collectionTagId,
    tags: post.tags.flatMap((x) => x.tag),
    images: [] as PostImageEditable[],
    collectionItemExists,
    // A fresh post has never been unpublished — supply the
    // PostUnpublishContext defaults so the type matches getPostEditDetail
    // (which carries these via the getPostDetail spread).
    wasPublished: false,
    unpublishedAt: null,
    unpublishedBy: null,
    parentModelId: null,
  };
};

export const updatePost = async ({
  id,
  user,
  ...data
}: PostUpdateInput & { user: SessionUser; availability?: Availability }) => {
  await throwOnBlockedUserContent([data.title, data.detail], {
    isModerator: user.isModerator,
    surface: 'post',
  });

  // Peel off a plain-Date publishedAt so it can be routed through the
  // anti-bump guard. Other update-input shapes (null, undefined,
  // FieldUpdateOperations) flow through prisma .update() unchanged.
  // Mirrors the pattern in updateModelVersion (model-version.service.ts).
  const publishedAt = data.publishedAt instanceof Date ? data.publishedAt : undefined;
  const restData = publishedAt !== undefined ? { ...data, publishedAt: undefined } : data;

  let publishedAtWritten = false;
  const post = await dbWrite.$transaction(async (tx) => {
    const updated = await tx.post.update({
      where: { id, userId: !user.isModerator ? user.id : undefined },
      data: {
        ...restData,
        title: !!restData.title ? (restData.title.length > 0 ? restData.title : null) : undefined,
        detail: !!restData.detail
          ? restData.detail.length > 0
            ? restData.detail
            : null
          : undefined,
      },
    });
    if (publishedAt !== undefined) {
      // Anti-bump guard: publishedAt is immutable once a post has gone
      // public. Allowed transitions: NULL (Draft/Unpublished) -> set, or
      // future (Scheduled) -> reschedule. Republish of an already-public
      // post is a no-op for this column.
      //
      // Write-once-on-republish: if `metadata.prevPublishedAt` is set, the
      // post was previously published then unpublished via the parent
      // model/version unpublish flow. Restore the original date regardless
      // of the submitted value — owners must not be able to bump a post to
      // the top of feeds by unpublishing the parent, then picking a new
      // `publishedAt` on the post edit page. Mirrors the CASE expressions
      // used by `publishModelVersionById` (model-version.service.ts) and
      // `publishModelById` (model.service.ts) when they fan out to attached
      // posts. Strip the stash on success.
      const writtenRows = await tx.$queryRaw<{ publishedAt: Date | null }[]>`
        UPDATE "Post"
        SET
          "publishedAt" = CASE
            WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
            THEN ("metadata"->>'prevPublishedAt')::timestamptz
            ELSE ${publishedAt}
          END,
          "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
        WHERE id = ${id}
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
        RETURNING "publishedAt"
      `;
      // Reflect the actually-written timestamp (may be the stashed
      // prevPublishedAt rather than the submitted value). The controller's
      // wasPublished check (post.controller.ts: `!post?.publishedAt &&
      // updatedPost.publishedAt`) needs this to fire reward / event-engine
      // side-effects on a fresh publish. When no row matched, the guard
      // blocked the write and the original returned value remains
      // authoritative. Propagate the value faithfully — including null —
      // rather than masking malformed stash data behind a truthy check.
      if (writtenRows.length > 0) {
        updated.publishedAt = writtenRows[0].publishedAt;
        publishedAtWritten = true;
      }
    }
    return updated;
  });

  await preventReplicationLag('post', post.id);
  await userPostCountCache.refresh(post.userId);

  // A publishedAt change moves the images' feed sort position
  // (GREATEST(publishedAt, scannedAt, createdAt)), but the DB-trigger-driven
  // updatedAt bump isn't reliably picked up by the metrics_images index — so
  // a reschedule would otherwise leave the index frozen at the original time.
  // Enqueue an explicit reindex so sortAt/publishedAtUnix get recomputed.
  if (publishedAtWritten) {
    const images = await dbWrite.image.findMany({
      where: { postId: post.id },
      select: { id: true },
    });
    if (images.length) {
      await queueImageSearchIndexUpdate({
        ids: images.map((i) => i.id),
        action: SearchIndexUpdateQueueAction.Update,
      });
    }
    await userImageVideoCountCaches.refresh(post.userId);
  }

  return post;
};

export const deletePost = async ({ id, isModerator }: GetByIdInput & { isModerator?: boolean }) => {
  // Phase 1: Atomic DB operations in a single transaction
  const { post, deletedImages } = await dbWrite.$transaction(
    async (tx) => {
      // Find images belonging to this post
      const images = await tx.$queryRaw<{ id: number; url: string }[]>`
        SELECT i.id, i.url
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i."postId" = ${id}
          AND ${Prisma.raw(isModerator ? '1 = 1' : 'i."userId" = p."userId"')}
      `;

      let deletedImages: { id: number; url: string }[] = [];
      if (images.length) {
        deletedImages = await tx.$queryRaw<{ id: number; url: string }[]>`
          DELETE FROM "Image"
          WHERE id IN (${Prisma.join(images.map((i) => i.id))})
          RETURNING id, url
        `;
      }

      // Delete the post
      const [post] = await tx.$queryRaw<{ id: number; nsfwLevel: number }[]>`
        DELETE FROM "Post"
        WHERE id = ${id}
        RETURNING id, "nsfwLevel"
      `;

      return { post, deletedImages };
    },
    // Back to 10s (2026-08-22). This was temporarily raised to 30s in #4276 while post
    // deletion was failing with Prisma P2028 "Transaction already closed"; that comment
    // said to revert once the slowness was root-caused, and it now has been.
    //
    // The cause was NOT this budget. `UserProfile.sfwCoverImageId` is a foreign key to
    // `Image` with ON DELETE SET NULL and no index, on a ~1.5 GB / 3.44M row table, so
    // Postgres's referential-integrity trigger full-scanned it ONCE PER DELETED IMAGE:
    // 1.74M calls at a 634 ms mean, ~290 hours of scan time, to null 12 rows. That made
    // this DELETE cost ~634 ms per image, which is why ~100 images took ~63 s and why
    // the failure was deterministic by post size rather than random.
    //
    // Fixed by the index in #4284, applied 2026-08-22 21:01:26Z. Measured after, on
    // production traffic: the RI trigger went 634 ms -> 0.003 ms over 2,613 calls, and
    // the plan went from ~193,719 buffers to 3. Slow (>5s) executions of this statement:
    // 11 in the six minutes before the index, ZERO in the fifteen minutes after.
    //
    // So 10s is no longer a tight budget — at 0.003 ms/image even a 1000-image post
    // spends ~3 ms in that trigger. Keeping 30s would only mean a genuinely stuck delete
    // takes three times as long to surface.
    { timeout: 10000 }
  );

  // Phase 2: Side effects after successful transaction
  if (deletedImages.length) {
    const imageIds = deletedImages.map((img) => img.id);

    await Promise.all([
      queueImageSearchIndexUpdate({ ids: imageIds, action: SearchIndexUpdateQueueAction.Delete }),
      invalidateManyImageExistence(imageIds),
    ]);

    // S3 deletion with concurrency limit
    await Limiter({ batchSize: 5 }).process(deletedImages, async (batch) =>
      Promise.all(batch.map(({ id, url }) => deleteImageFromS3({ id, url })))
    );
  }

  await bustCachesForPosts(id);

  return post;
};

type PostQueryResult = { id: number; name: string; isCategory: boolean }[];
export const getPostTags = async ({
  query,
  limit,
  excludedTagIds,
  nsfwLevel,
}: GetPostTagsInput & { excludedTagIds?: number[] }) => {
  const showTrending = query === undefined || query.length < 2;
  const tags = await dbRead.$queryRaw<PostQueryResult>`
    SELECT t.id,
           t.name,
           (SELECT COALESCE(
                     (SELECT MAX(pt."nsfwLevel")
                      FROM "TagsOnTags" tot
                             JOIN "Tag" pt ON tot."fromTagId" = pt.id
                      WHERE tot."toTagId" = t.id), t."nsfwLevel") "nsfwLevel") "nsfwLevel",
           t."isCategory"
    FROM "Tag" t
    LEFT JOIN "TagMetric" m ON m."tagId" = t.id AND m.timeframe = 'AllTime'
    WHERE ${
      showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`
    }
            ${nsfwLevel ? Prisma.sql`AND (t."nsfwLevel" & ${nsfwLevel}) != 0` : ``}
    ORDER BY m."postCount" DESC NULLS LAST
    LIMIT ${limit}
  `;

  return !!excludedTagIds?.length ? tags.filter((x) => !excludedTagIds.includes(x.id)) : tags;
};

export const addPostTag = async ({ id: postId, name: initialName }: AddPostTagInput) => {
  const name = initialName.toLowerCase().trim();
  return await dbWrite.$transaction(async (tx) => {
    const tag = await tx.tag.findUnique({
      where: { name },
      select: { id: true, target: true },
    });
    if (!tag) {
      return await tx.tag.create({
        data: {
          type: TagType.UserGenerated,
          target: [TagTarget.Post],
          name,
          tagsOnPosts: {
            create: {
              postId,
            },
          },
        },
        select: simpleTagSelect,
      });
    } else {
      // update the tag target if needed
      return await tx.tag.update({
        where: { id: tag.id },
        data: {
          target: !tag.target.includes(TagTarget.Post) ? { push: TagTarget.Post } : undefined,
          tagsOnPosts: {
            connectOrCreate: {
              where: { tagId_postId: { tagId: tag.id, postId } },
              create: { postId },
            },
          },
        },
        select: simpleTagSelect,
      });
    }
  });
};

export const removePostTag = ({ tagId, id: postId }: RemovePostTagInput) => {
  return dbWrite.tagsOnPost.delete({ where: { tagId_postId: { tagId, postId } } });
};

const log = (data: MixedObject) => {
  logToAxiom({ name: 'post-service', type: 'error', ...data }).catch();
};

const DETAIL_LIMIT = 10;

const parseExternalMetadata = async (src: string | undefined, user: number) => {
  if (!src) return;

  const srcUrl = new URL(src);
  if (!env.POST_INTENT_DETAILS_HOSTS || !env.POST_INTENT_DETAILS_HOSTS.includes(srcUrl.origin)) {
    return log({ user, message: 'This domain is not approved for external parsing.', domain: src });
  }

  let respJson;
  try {
    const response = await fetch(src);
    respJson = await response.json();
  } catch (e) {
    return log({ user, message: 'Failure fetching JSON data from external URL.', domain: src });
  }

  const detailParse = externalMetaSchema.safeParse(respJson);
  if (!detailParse.success) {
    return log({
      user,
      message: 'Failure parsing JSON data from external URL.',
      domain: src,
      issues: z.flattenError(detailParse.error),
    });
  }

  // TODO it is possible we will eventually want to do some test of mediaUrl domain = detailsUrl domain
  //  but that can cause problems for different cdns vs apis.
  //  Another option is putting the mediaUrl into the detailsUrl structure
  //  but that can impose extra work if the partner just wants to put their name and homepage on everything
  //  and not worry about having to modify the API to include each URL

  const { data: detailData } = detailParse;

  if (!!detailData.details) {
    const detailLength = Object.keys(detailData.details).length;
    if (detailLength > DETAIL_LIMIT) {
      return log({
        user,
        message: 'Too many keys in "details" for external data.',
        domain: src,
        found: detailLength,
      });
    }
  }

  return detailData;
};

export const addPostImage = async ({
  modelVersionId,
  meta,
  user,
  externalDetailsUrl,
  ...props
}: ImageSchema & { user: SessionUser; postId: number; generationWorkflowId?: string }) => {
  const externalData = await parseExternalMetadata(externalDetailsUrl, user.id);
  if (externalData) {
    meta = { ...meta, external: externalData };
  }

  // If no meta was supplied (headless/MCP upload), try to extract it from the
  // image EXIF. The image is already on the CDN at this point so we can fetch
  // it by URL. We only do this when meta is absent to avoid overwriting
  // caller-supplied values.
  if (!meta && props.url && props.type !== MediaType.video) {
    try {
      const edgeUrl = getEdgeUrl(props.url, { original: true });
      const extracted = await getMetadata(edgeUrl);
      if (extracted && Object.keys(extracted).length > 0) meta = extracted;
    } catch {
      // Non-fatal — proceed without metadata rather than failing the upload
    }
  }

  let toolId: number | undefined;
  const { name: sourceName, homepage: sourceHomepage } = meta?.external?.source ?? {};
  if (meta && 'engine' in meta) {
    toolId = (await getToolByAlias(meta.engine as string))?.id;
    if (!toolId) {
      toolId = (await getToolByName(meta.engine as string))?.id;
    }
  } else if (sourceName || sourceHomepage) {
    if (sourceName) {
      toolId = (await getToolByName(sourceName))?.id;
    }
    if (sourceHomepage && !toolId) {
      toolId = (await getToolByDomain(sourceHomepage))?.id;
    }
  }

  let techniqueId: number | undefined;
  if (meta && 'engine' in meta) {
    // older meta has type: string, but the updated meta has process: string
    const rawProcess = (meta.process ?? meta.type ?? meta.workflow) as string | undefined;
    // Graph workflow keys carry a variant suffix (e.g. 'img2img:hires-fix'); techniques are
    // keyed on the base ('img2img'), so match on the segment before the colon.
    const process = rawProcess?.split(':')[0];
    if (process) {
      techniqueId = (await getTechniqueByName(process))?.id;
    }
  }

  const post = await dbRead.post.findFirst({
    where: { id: props.postId },
    select: {
      userId: true,
      collection: {
        select: {
          metadata: true,
        },
      },
    },
  });

  if (!post) throw throwNotFoundError(`No post with id ${props.postId}`);
  if (post.userId !== user.id) throw throwAuthorizationError();

  const collectionMeta = (post?.collection?.metadata ?? {}) as CollectionMetadataSchema;

  // Idempotency guard: if the same (postId, url) pair was just saved — e.g. by
  // a retried mutation or a duplicated client submission — return the existing
  // record instead of creating a second one. The client generates a unique S3
  // key per upload, so a collision here means the same upload is being saved
  // twice.
  if (props.url) {
    const existing = await dbRead.image.findFirst({
      where: { postId: props.postId, url: props.url },
      select: { id: true },
    });
    if (existing) {
      const existingResult = await dbWrite.image.findUnique({
        where: { id: existing.id },
        select: editPostImageSelect,
      });
      if (existingResult) {
        const [existingImage] = await combinePostEditImageData([existingResult], user);
        return existingImage;
      }
    }
  }

  const { generationWorkflowId, ...imageProps } = props;
  const verifiedSourceImageIds = await resolveVerifiedSourceImageIds({
    userId: user.id,
    provenance: (meta?.extra as { provenance?: unknown } | undefined)?.provenance,
    workflowId: generationWorkflowId,
  });

  const partialResult = await createImage({
    ...imageProps,
    meta,
    verifiedSourceImageIds,
    userId: user.id,
    toolIds: toolId ? [toolId] : undefined,
    techniqueIds: techniqueId ? [techniqueId] : undefined,
    skipIngestion: collectionMeta.judgesApplyBrowsingLevel,
  });

  await createImageResources({ imageId: partialResult.id }).catch(handleLogError);

  const result = await dbWrite.image.findUnique({
    where: { id: partialResult.id },
    select: editPostImageSelect,
  });
  if (!result) throw throwDbError(`Image not found`);
  const [image] = await combinePostEditImageData([result], user);

  const modelVersionIds = image.resourceHelper.map((r) => r.modelVersionId).filter(isDefined);
  // Cache Busting — parallelize independent operations
  const cacheBustPromises: Promise<void>[] = [
    bustCacheTag(`images-user:${user.id}`),
    preventReplicationLag('postImages', props.postId),
  ];
  if (modelVersionIds.length) {
    cacheBustPromises.push(
      ...modelVersionIds.map((mvId) => bustCacheTag(`images-modelVersion:${mvId}`))
    );
    cacheBustPromises.push(
      dbRead.modelVersion
        .findMany({
          where: { id: { in: modelVersionIds } },
          select: { modelId: true },
        })
        .then((mvs) => Promise.all(mvs.map((mv) => bustCacheTag(`images-model:${mv.modelId}`))))
        .then(() => undefined)
    );
  }
  cacheBustPromises.push(bustCachesForPosts(props.postId));
  await Promise.all(cacheBustPromises);

  return image;
};

export async function bustCachesForPosts(postIds: number | number[]) {
  const ids = Array.isArray(postIds) ? postIds : [postIds];
  // `Prisma.join([])` throws. deleteImages drops the Image rows before this runs and deletes the
  // S3 objects after, so throwing here on a batch of postless images strands them publicly
  // reachable with no row left to find them by.
  if (!ids.length) return;
  // Use dbWrite — bustCachesForPosts runs immediately after image/post writes
  // so the replica may not yet reflect the post.modelVersionId we need.
  // LEFT JOIN ModelVersion so Model3D-linked posts (modelVersionId = null,
  // model3dId set) aren't filtered out by the join — without this we never
  // bust `images-model3d:` and the gallery serves stale empty results until
  // CacheTTL.md (10m) expires.
  const results = await dbWrite.$queryRaw<
    {
      isShowcase: boolean | null;
      modelVersionId: number | null;
      modelId: number | null;
      model3dId: number | null;
    }[]
  >`
    SELECT m."userId" = p."userId" as "isShowcase",
           p."modelVersionId",
           mv."modelId",
           p."model3dId"
    FROM "Post" p
           LEFT JOIN "ModelVersion" mv ON mv."id" = p."modelVersionId"
           LEFT JOIN "Model" m ON m."id" = mv."modelId"
    WHERE p."id" IN (${Prisma.join(ids)})
  `;

  // Bust getAllImages model-gallery cache for ALL affected modelVersions/models —
  // not just showcase posts. Deletion/moderation paths also call this, and stale
  // gallery results for deleted/blocked images would defeat fast removal (e.g.
  // DMCA, CSAM, policy moderation). Deduplicate to avoid redundant Redis ops.
  const modelVersionIds = [
    ...new Set(results.map((x) => x.modelVersionId).filter((x): x is number => x != null)),
  ];
  const modelIds = [
    ...new Set(results.map((x) => x.modelId).filter((x): x is number => x != null)),
  ];
  const model3dIds = [
    ...new Set(results.map((x) => x.model3dId).filter((x): x is number => x != null)),
  ];
  await Promise.all([
    ...modelVersionIds.map((mvId) => bustCacheTag(`images-modelVersion:${mvId}`)),
    ...modelIds.map((mId) => bustCacheTag(`images-model:${mId}`)),
    ...model3dIds.map((mId) => bustCacheTag(`images-model3d:${mId}`)),
  ]);

  const showcaseVersionIds = results
    .filter((x) => x.isShowcase && x.modelVersionId != null)
    .map((x) => x.modelVersionId as number);
  if (!showcaseVersionIds.length) return;

  // Flag modelVersion-lag so imagesForModelVersionsCache.lookupFn (cache-miss
  // path) routes to primary during the replication window. Then refresh
  // instead of bust — refresh actively repopulates from primary, so a
  // concurrent reader can't poison the cache with `images: []` during the
  // bust debounce window.
  await preventReplicationLagBatch('modelVersion', showcaseVersionIds);
  await imagesForModelVersionsCache.refresh(showcaseVersionIds);
}

export const updatePostImage = async (image: UpdatePostImageInput) => {
  const currentImage = await dbWrite.image.findUniqueOrThrow({
    where: { id: image.id },
    select: {
      hideMeta: true,
      ingestion: true,
      blockedFor: true,
      metadata: true,
      nsfwLevel: true,
      meta: true,
    },
  });

  // `meta` is optional on this input, and the difference matters: absent means "leave the
  // stored metadata alone" (the hide/show-prompt toggle sends only `hideMeta`), while an
  // explicit `null` means "clear it". Collapsing the two writes SQL NULL over metadata the
  // caller never touched, so the write below is skipped entirely unless the key was sent.
  const metaProvided = image.meta !== undefined;

  // This edit replaces meta wholesale from client input, so provenance has to be
  // re-derived from the row rather than accepted: otherwise editing an image you
  // already own is a way to assert a derivation you never made.
  const meta = metaProvided
    ? sanitizeProvenance(
        image.meta as Record<string, unknown> | null | undefined,
        storedSourceImageIds(currentImage.meta)
      )
    : undefined;

  const blockedForVerification = currentImage.blockedFor === BlockedReason.AiNotVerified;
  const updatedIsVerifiable = isValidAIGeneration({
    id: image.id,
    nsfwLevel: currentImage.nsfwLevel,
    meta: image.meta,
  });

  const shouldIngest = blockedForVerification && updatedIsVerifiable;

  const result = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      id: undefined, // prevent updating the id!
      updatedAt: new Date(),
      // undefined = omit the column from the UPDATE; Prisma.JsonNull = write SQL NULL.
      meta: metaProvided
        ? meta != null
          ? (meta as Prisma.JsonObject)
          : Prisma.JsonNull
        : undefined,
      // If this image was blocked due to missing metadata, we need to set it back to pending
      ingestion: shouldIngest ? 'Pending' : undefined,
      blockedFor: shouldIngest ? null : undefined,
      metadata: {
        ...((currentImage.metadata as MixedObject) ?? {}),
      } as Prisma.JsonObject,
    },
    select: { id: true, url: true, userId: true },
  });
  // Parallelize independent cache refreshes — none read what others write.
  // ingestImage stays sequential after: it does not read these caches but
  // does have ordering relative to the dbWrite.image.update above.
  const cacheRefreshPromises: Promise<unknown>[] = [
    imageMetadataCache.refresh(image.id),
    imageMetaCache.refresh(image.id),
    userPostCountCache.refresh(result.userId),
  ];
  if (image.hideMeta && currentImage && currentImage.hideMeta !== image.hideMeta) {
    // 🔴 SCOPED — this image STAYS LIVE. The flip re-keys it (the cache key includes hideMeta), so
    // what needs clearing is only the variants derived BEFORE the flip, which still carry the
    // metadata the user just asked to hide and remain publicly fetchable at stable URLs until the
    // cache bucket ages them out. The post-flip variants are what the page is serving right now;
    // removing those too would blank a live image until each cache tier caught up.
    //
    // The delete path (deleteImageFromS3 below) deliberately does NOT pass a scope — there the row
    // is already gone and the image must stop serving entirely.
    cacheRefreshPromises.push(purgeResizeCache({ url: result.url, scope: 'hidden-meta-orphans' }));
  }
  // Bust the image-delivery metadata cache on ANY hideMeta change (both directions): that
  // cache serves { hideMeta } to the delivery/resize path, and a stale value would keep
  // embedding (or keep stripping) generation metadata for up to its TTL. The privacy-
  // sensitive direction (false -> true) is the reason this bust is explicit rather than
  // TTL-bounded.
  if (image.hideMeta !== undefined && currentImage && currentImage.hideMeta !== image.hideMeta) {
    cacheRefreshPromises.push(bustImageDeliveryMetadataCache(result.url));
  }
  await Promise.all(cacheRefreshPromises);

  if (shouldIngest) {
    // Ensures a proper rescan of this image.
    enqueueImageIngestion({
      images: [result as IngestImageInput],
      name: 'post-image-ingest',
      userId: result.userId,
    });
  }

  purgeImageGenerationDataCache(image.id);
};

export const addResourceToPostImage = async ({
  id: imageIds,
  modelVersionId,
  user,
}: AddResourceToPostImageInput & { user: SessionUser }) => {
  if (!imageIds.length) {
    throw throwBadRequestError('Must include at least one image.');
  }

  const modelVersion = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      model: { select: { name: true, id: true } },
      name: true,
      files: {
        select: {
          hashes: {
            select: {
              hash: true,
            },
            where: {
              type: ModelHashType.AutoV2,
            },
          },
        },
      },
    },
  });

  if (!modelVersion) throw throwNotFoundError('Model version not found.');

  // Read from primary — users can attach a resource within seconds of posting
  // the image, so the replica (5-10s lag) would return fewer rows and throw
  // a spurious "Image not found".
  const images = await dbWrite.image.findMany({
    where: { id: { in: imageIds } },
    select: { postId: true, meta: true, resourceHelper: true, type: true },
  });

  if (images.length !== imageIds.length) {
    throw throwNotFoundError(`Image${imageIds.length > 1 ? 's' : ''} not found.`);
  }
  // TODO technically this can be called with a combo of on/off site imgs
  if (
    images.some((i) => i.type !== MediaType.video && isImageMetaOnSite(i.meta as ImageMetaProps))
  ) {
    throw throwBadRequestError('Cannot add resources to on-site generations.');
  }

  // Manually crediting resources on an uploaded/external image is an attribution
  // action with no GPU cost, so it uses a fixed cap rather than the per-tier
  // generation limits (those are throttled during GPU crunches — see the
  // MAX_RESOURCES_PER_IMAGE comment in server/common/constants).
  const resourceLimit = MAX_RESOURCES_PER_IMAGE;

  images.forEach((img) => {
    const numExistingResources = img.resourceHelper.length;
    if (numExistingResources >= resourceLimit) {
      throw throwBadRequestError(`Maximum resources reached (${resourceLimit})`);
    }
  });

  // TODO restrictions on allowedTypes

  // noinspection JSPotentiallyInvalidTargetOfIndexedPropertyAccess
  // const hash = modelVersion.files?.[0]?.hashes?.[0]?.hash?.toLowerCase();

  const createdResources = await dbWrite.imageResourceNew.createManyAndReturn({
    data: imageIds.map((imageId) => ({
      modelVersionId,
      imageId,
      detected: false,
    })),
    skipDuplicates: true,
    select: { modelVersionId: true, imageId: true },
  });

  if (createdResources.length > 0) {
    await queueImageSearchIndexUpdate({
      ids: uniq(createdResources.map((x) => x.imageId)),
      action: SearchIndexUpdateQueueAction.Update,
    });
  }

  // TODO are these necessary?
  // - Cache Busting

  await imageResourcesCache.refresh(createdResources.map((x) => x.imageId));
  await bustCacheTag(`images-user:${user.id}`);
  await bustCacheTag(`images-modelVersion:${modelVersionId}`);
  await bustCacheTag(`images-model:${modelVersion.model.id}`);

  for (const image of images) {
    if (!!image.postId) {
      await preventReplicationLag('postImages', image.postId);
      await bustCachesForPosts(image.postId);
    }
  }

  return dbWrite.imageResourceHelper.findMany({
    where: {
      imageId: { in: createdResources.map((x) => x.imageId) },
      modelVersionId: { in: createdResources.map((x) => x.modelVersionId) },
    },
  });
};

export const removeResourceFromPostImage = async ({
  id: imageId,
  modelVersionId,
  user,
}: RemoveResourceFromPostImageInput & { user: SessionUser }) => {
  const image = await dbRead.image.findFirst({
    where: { id: imageId },
    select: { postId: true },
  });

  if (!image) throw throwNotFoundError('Image not found.');
  // TODO add check for isOnSite and return

  const deleted = await dbWrite.imageResourceNew.delete({
    where: { imageId_modelVersionId: { imageId, modelVersionId } },
  });

  await queueImageSearchIndexUpdate({
    ids: [imageId],
    action: SearchIndexUpdateQueueAction.Update,
  });

  // TODO are these necessary?
  // - Cache Busting

  await imageResourcesCache.refresh(imageId);
  await bustCacheTag(`images-user:${user.id}`);
  await bustCacheTag(`images-modelVersion:${modelVersionId}`);

  if (!!image.postId) {
    await preventReplicationLag('postImages', image.postId);
    await bustCachesForPosts(image.postId);
  }

  return deleted;
};

export const reorderPostImages = async ({ id: postId, imageIds }: ReorderPostImagesInput) => {
  const transaction = await dbWrite.$transaction(
    imageIds.map((id, index) => dbWrite.image.update({ where: { id, postId }, data: { index } }))
  );

  await updatePostNsfwLevel(postId);
  await bustCachesForPosts(postId);

  return transaction;
};

export const getPostResources = async ({ id }: GetByIdInput) => {
  return await dbRead.postResourceHelper.findMany({
    where: { postId: id },
    orderBy: { modelName: 'asc' },
  });
};

export const updatePostNsfwLevel = async (ids: number | number[]) => {
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids)].filter(isDefined); // dedupe
  if (!ids.length) return;

  await dbWrite.$executeRawUnsafe(`
    -- Update post NSFW level
    SELECT update_post_nsfw_levels(ARRAY[${ids.join(',')}]);
  `);
};

export const getPostContestCollectionDetails = async ({
  id,
  userId,
}: GetByIdInput & { userId?: number }) => {
  const post = await dbRead.post.findUnique({
    where: { id },
    select: { collectionId: true, userId: true },
  });

  if (!post || !post.collectionId)
    return {
      collection: null,
      permissions: null,
      items: [],
    };

  const collection = await getCollectionById({ input: { id: post.collectionId } });

  if (!collection || collection?.mode !== CollectionMode?.Contest)
    return {
      collection: null,
      permissions: null,
      items: [],
    };

  const isImageCollection = collection.type === CollectionType.Image;

  const images = isImageCollection
    ? await dbRead.image.findMany({
        where: { postId: id },
      })
    : [];

  const items = await dbRead.collectionItem.findMany({
    where: {
      collectionId: post.collectionId,
      postId: isImageCollection ? undefined : id,
      imageId: isImageCollection ? { in: images.map((i) => i.id) } : undefined,
    },
    select: {
      id: true,
      postId: true,
      imageId: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
      tag: true,
    },
  });

  const permissions = await getUserCollectionPermissionsById({
    id: post.collectionId,
    userId,
  });

  return {
    collection,
    items: items.map((item) => {
      return {
        ...item,
        collection,
      };
    }),
    permissions,
  };
};

export const updatePostCollectionTagId = async ({
  id,
  collectionTagId,
}: UpdatePostCollectionTagIdInput) => {
  const post = await dbRead.post.findUnique({
    where: { id },
    select: { collectionId: true, userId: true },
  });

  if (!post || !post.collectionId) return;

  const collection = await getCollectionById({ input: { id: post.collectionId } });

  if (!collection || collection?.mode !== CollectionMode?.Contest) return;

  if (!collection.tags.find((t) => t.id === collectionTagId))
    throw throwBadRequestError('Invalid tag');

  const isImageCollection = collection.type === CollectionType.Image;

  const images = isImageCollection
    ? await dbRead.image.findMany({
        where: { postId: id },
      })
    : [];

  await dbWrite.collectionItem.updateMany({
    where: {
      collectionId: post.collectionId,
      postId: isImageCollection ? undefined : id,
      imageId: isImageCollection ? { in: images.map((i) => i.id) } : undefined,
    },
    data: {
      tagId: collectionTagId,
    },
  });
};
