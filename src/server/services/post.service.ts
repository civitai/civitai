import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isMadeOnSite } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { env } from '~/env/server';
import { PostSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { thumbnailCache, userContentOverviewCache } from '~/server/redis/caches';
import { GetByIdInput } from '~/server/schema/base.schema';
import { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { externalMetaSchema, ImageMetaProps, ImageSchema } from '~/server/schema/image.schema';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import {
  editPostImageSelect,
  PostImageEditProps,
  PostImageEditSelect,
  postSelect,
} from '~/server/selectors/post.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { getGenerationStatus } from '~/server/services/generation/generation.service';
import {
  createImage,
  createImageResources,
  deleteImageById,
  deleteImagesForModelVersionCache,
  getImagesForPosts,
  purgeImageGenerationDataCache,
  purgeResizeCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { findOrCreateTagsByName, getVotableImageTags } from '~/server/services/tag.service';
import { getTechniqueByName } from '~/server/services/technique.service';
import { getToolByDomain, getToolByName, getToolByAlias } from '~/server/services/tool.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
import { getPeriods } from '~/server/utils/enum-helpers';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { generationFormWorkflowConfigurations } from '~/shared/constants/generation.constants';
import {
  Availability,
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  MediaType,
  ModelHashType,
  TagTarget,
  TagType,
} from '~/shared/utils/prisma/enums';
import { PreprocessFileReturnType } from '~/utils/media-preprocessors';
import { postgresSlugify } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { CacheTTL } from '../common/constants';
import {
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
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
  profilePictureId: number | null;
  publishedAt: Date | null;
  cursorId: Date | number | null;
  modelVersionId: number | null;
  collectionId: number | null;
  availability: Availability;
  detail?: string | null;
  stats: {
    commentCount: number;
    likeCount: number;
    dislikeCount: number;
    heartCount: number;
    laughCount: number;
    cryCount: number;
  } | null;
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
};
export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];
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
  followed,
  clubId,
  browsingLevel,
  pending,
}: Omit<PostsQueryInput, 'include'> & {
  user?: SessionUser;
  include?: string[];
}) => {
  const AND = [Prisma.sql`1 = 1`];
  const WITH: Prisma.Sql[] = [];
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

  // TODO.clubs: This is temporary until we are fine with displaying club stuff in public feeds.
  // At that point, we should be relying more on unlisted status which is set by the owner.
  const hidePrivatePosts =
    !ids && !clubId && !isOwnerRequest && !(!!user && followed) && !(collectionId && !!user?.id);

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

  const joins: string[] = [
    `${
      draftOnly ? 'LEFT ' : ''
    }JOIN "PostMetric" pm ON pm."postId" = p.id AND pm."timeframe" = 'AllTime'::"MetricTimeframe"`,
  ];
  if (!isOwnerRequest) {
    AND.push(Prisma.sql`pm."ageGroup" IS NOT NULL`);

    if (!!tags?.length)
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "TagsOnPost" top
        WHERE top."postId" = p.id AND top."tagId" IN (${Prisma.join(tags)})
      )`);

    if (query) {
      AND.push(Prisma.sql`p.title ILIKE ${query + '%'}`);
    }
  } else {
    if (draftOnly) AND.push(Prisma.sql`pm."ageGroup" IS NULL`);
    else AND.push(Prisma.sql`pm."ageGroup" IS NOT NULL`);
  }

  if (period !== 'AllTime' && periodMode !== 'stats') {
    if (draftOnly) {
      const interval = period.toLowerCase();
      AND.push(
        Prisma.sql`p."createdAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(interval)}'`
      );
    } else {
      const ageGroups = getPeriods(period);
      AND.push(
        Prisma.sql`pm."ageGroup" = ANY(ARRAY[${Prisma.join(ageGroups)}]::"MetricTimeframe"[])`
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

    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      WHERE ci."collectionId" = ${collectionId}
        AND ci."postId" = p.id
        AND (ci."status" = 'ACCEPTED' ${Prisma.raw(displayReviewItems)})
    )`);
  }

  if (excludedUserIds?.length) {
    AND.push(Prisma.sql`p."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }

  // sorting
  let orderBy = 'p."publishedAt" DESC NULLS LAST';
  if (sort === PostSort.MostComments) {
    orderBy = `pm."commentCount" DESC`;
    AND.push(Prisma.sql`pm."commentCount" > 0`);
  } else if (sort === PostSort.MostReactions) {
    orderBy = `pm."reactionCount" DESC`;
    AND.push(Prisma.sql`pm."reactionCount" > 0`);
  } else if (sort === PostSort.MostCollected) {
    orderBy = `pm."collectedCount" DESC`;
    AND.push(Prisma.sql`pm."collectedCount" > 0`);
  }

  // cursor
  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    const cursorValue = cursorProp === 'p."publishedAt"' ? new Date(cursor) : Number(cursor);
    if (cursorProp)
      AND.push(Prisma.sql`${Prisma.raw(cursorProp + ' ' + cursorOperator)} ${cursorValue}`);
  }

  if (clubId) {
    cacheTime = 0; //CacheTTL.day;
    cacheTags.push(`posts-club:${clubId}`);

    WITH.push(Prisma.sql`
      "clubPosts" AS (
        SELECT DISTINCT ON (p."id") p."id" as "postId"
        FROM "EntityAccess" ea
        JOIN "Post" p ON p."id" = ea."accessToId"
        LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" AND ct."clubId" = ${clubId}
        WHERE (
            (
             ea."accessorType" = 'Club' AND ea."accessorId" = ${clubId}
            )
            OR (
              ea."accessorType" = 'ClubTier' AND ct."clubId" = ${clubId}
            )
          )
          AND ea."accessToType" = 'Post'
      )
    `);

    joins.push(`JOIN "clubPosts" cp ON cp."postId" = p."id"`);
  }

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;

  const postsRawQuery = Prisma.sql`
    ${queryWith}
    SELECT
      p.id,
      p."nsfwLevel",
      p.title,
      p."userId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      u."profilePictureId",
      p."publishedAt",
      p."unlisted",
      p."modelVersionId",
      p."collectionId",
      ${include?.includes('detail') ? Prisma.sql`p."detail",` : Prisma.sql``}
      p."availability",
      jsonb_build_object(
        'cryCount', COALESCE(pm."cryCount", 0),
        'laughCount', COALESCE(pm."laughCount", 0),
        'likeCount', COALESCE(pm."likeCount", 0),
        'dislikeCount', COALESCE(pm."dislikeCount", 0),
        'heartCount', COALESCE(pm."heartCount", 0),
        'commentCount', COALESCE(pm."commentCount", 0)
      ) "stats",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
    FROM "Post" p
    JOIN "User" u ON u.id = p."userId"
    ${Prisma.raw(joins.join('\n'))}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit + 1}`;

  if (
    query ||
    isOwnerRequest ||
    (!!user && followed) ||
    !env.POST_QUERY_CACHING ||
    (collectionId && !!user?.id)
  ) {
    cacheTime = 0;
  }

  const cacheable = queryCache(dbRead, 'getPostsInfinite', 'v1');
  const postsRaw = await cacheable<GetAllPostsRaw[]>(postsRawQuery, {
    ttl: cacheTime,
    tag: cacheTags,
  });

  let nextCursor: number | Date | undefined | null;
  if (postsRaw.length > limit) {
    const nextItem = postsRaw.pop();
    nextCursor = nextItem?.cursorId;
  }

  const images = postsRaw.length
    ? await getImagesForPosts({
        postIds: postsRaw.map((x) => x.id),
        // excludedIds: excludedImageIds,
        user,
        browsingLevel,
        pending,
      })
    : [];

  // Get user cosmetics
  const userIds = postsRaw.map((i) => i.userId);
  const userCosmetics = includeCosmetics ? await getCosmeticsForUsers(userIds) : undefined;
  const cosmetics = includeCosmetics
    ? await getCosmeticsForEntity({ ids: postsRaw.map((p) => p.id), entity: 'Post' })
    : {};

  const profilePictures = await getProfilePicturesForUsers(userIds);

  // Filter to published model versions:
  const filterByPermissionContent = !isOwnerRequest && !user?.isModerator;
  const modelVersionIds = postsRaw.map((p) => p.modelVersionId).filter(isDefined);
  const modelVersions =
    modelVersionIds.length > 0 && filterByPermissionContent
      ? await dbRead.modelVersion.findMany({
          where: { id: { in: postsRaw.map((p) => p.modelVersionId).filter(isDefined) } },
          select: { status: true, id: true },
        })
      : [];

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
    items: postsRaw
      // remove unlisted resources the user has no access to:
      .filter((p) => {
        // Hide private posts from the main feed.
        if (hidePrivatePosts && p.availability === Availability.Private) {
          return false;
        }

        // Allow mods and owners to view all.
        if (user?.isModerator || p.userId === user?.id) return true;

        // Hide posts from unpublished model versions:
        if (
          p.modelVersionId &&
          modelVersions.find((x) => x.id === p.modelVersionId)?.status !== 'Published'
        ) {
          return false;
        }

        // Hide posts from collections the user has no access to:
        if (p.collectionId) {
          const collection = collections.find((x) => x.id === p.collectionId);
          if (!collection) return false;

          if (
            collection.read !== CollectionReadConfiguration.Public &&
            !collection?.contributors[0]?.permissions.includes(CollectionContributorPermission.VIEW)
          ) {
            return false;
          }
        }

        return true;
      })
      .map(({ stats, username, userId: creatorId, userImage, deletedAt, ...post }) => {
        const _images = images.filter((x) => x.postId === post.id);

        return {
          ...post,
          imageCount: _images.length,
          user: {
            id: creatorId,
            username,
            image: userImage,
            deletedAt,
            cosmetics: userCosmetics?.[creatorId] ?? [],
            profilePicture: profilePictures[creatorId] ?? null,
          },
          stats,
          images: _images,
          cosmetic: cosmetics[post.id] ?? null,
        };
      })
      .filter((x) => x.imageCount !== 0),
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

  return {
    ...post,
    detail: post.detail,
    tags: post.tags.flatMap((x) => x.tag),
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

  return { ...post, collectionTagId, images, collectionItemExists };
};

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

  const post = await dbWrite.post.create({
    data: { ...data, userId, tags: tagsToAdd.length > 0 ? { create: tagData } : undefined },
    select: postSelect,
  });

  await preventReplicationLag('post', post.id);
  await userContentOverviewCache.bust(userId);

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
  };
};

export const updatePost = async ({
  id,
  user,
  ...data
}: PostUpdateInput & { user: SessionUser }) => {
  if (data.title) await throwOnBlockedLinkDomain(data.title);
  if (data.detail) await throwOnBlockedLinkDomain(data.detail);
  const post = await dbWrite.post.update({
    where: { id, userId: !user.isModerator ? user.id : undefined },
    data: {
      ...data,
      title: !!data.title ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: !!data.detail ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });
  await preventReplicationLag('post', post.id);
  await userContentOverviewCache.bust(post.userId);

  return post;
};

export const deletePost = async ({ id, isModerator }: GetByIdInput & { isModerator?: boolean }) => {
  const images = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT i.id
    FROM "Image" i
    JOIN "Post" p ON p.id = "postId"
    WHERE i."postId" = ${id}
      AND ${Prisma.raw(isModerator ? '1 = 1' : 'i."userId" = p."userId"')}
  `;
  if (images.length) {
    for (const image of images) await deleteImageById({ id: image.id, updatePost: false });
  }

  await bustCachesForPost(id);
  const [result] = await dbWrite.$queryRaw<{ id: number; nsfwLevel: number }[]>`
    DELETE FROM "Post"
    WHERE id = ${id}
    RETURNING id, "nsfwLevel"
  `;
  return result;
};

type PostQueryResult = { id: number; name: string; isCategory: boolean; postCount: number }[];
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
           t."isCategory",
           COALESCE(${
             showTrending ? Prisma.sql`s."postCountWeek"` : Prisma.sql`s."postCountAllTime"`
           }, 0)::int AS                                                       "postCount"
    FROM "Tag" t
           LEFT JOIN "TagStat" s ON s."tagId" = t.id
           LEFT JOIN "TagRank" r ON r."tagId" = t.id
    WHERE ${
      showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`
    }
            ${nsfwLevel ? Prisma.sql`AND (t."nsfwLevel" & ${nsfwLevel}) != 0` : ``}
    ORDER BY ${Prisma.raw(
      showTrending ? `r."postCountWeekRank" ASC` : `r."postCountAllTimeRank" ASC`
    )}
    LIMIT ${limit}
  `;

  return (
    !!excludedTagIds?.length ? tags.filter((x) => !excludedTagIds.includes(x.id)) : tags
  ).sort((a, b) => b.postCount - a.postCount);
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
      issues: detailParse.error.issues,
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
}: ImageSchema & { user: SessionUser; postId: number }) => {
  const externalData = await parseExternalMetadata(externalDetailsUrl, user.id);
  if (externalData) {
    meta = { ...meta, external: externalData };
  }

  let toolId: number | undefined;
  const { name: sourceName, homepage: sourceHomepage } = meta?.external?.source ?? {};
  if (meta && 'engine' in meta) {
    toolId = (await getToolByAlias(meta.engine as string))?.id;
  } else if (sourceName || sourceHomepage) {
    if (sourceName) {
      toolId = (await getToolByName(sourceName))?.id;
    }
    if (sourceHomepage && !toolId) {
      toolId = (await getToolByDomain(sourceHomepage))?.id;
    }
  }

  let techniqueId: number | undefined;
  if (meta && 'workflow' in meta) {
    const workflow = generationFormWorkflowConfigurations.find((x) => x.key === meta.workflow);
    if (workflow) {
      techniqueId = (await getTechniqueByName(workflow.subType))?.id;
    }
  }

  const post = await dbRead.post.findFirst({
    where: { id: props.postId },
    select: {
      collection: {
        select: {
          metadata: true,
        },
      },
    },
  });

  const collectionMeta = (post?.collection?.metadata ?? {}) as CollectionMetadataSchema;

  const partialResult = await createImage({
    ...props,
    meta,
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
  // Cache Busting
  await bustCacheTag(`images-user:${user.id}`);
  if (!!modelVersionIds.length) {
    for (const modelVersionId of modelVersionIds) {
      await bustCacheTag(`images-modelVersion:${modelVersionId}`);
    }

    const modelVersions = await dbRead.modelVersion.findMany({
      where: { id: { in: modelVersionIds } },
      select: { modelId: true },
    });
    for (const modelVersion of modelVersions) {
      await bustCacheTag(`images-model:${modelVersion.modelId}`);
    }
  }

  await preventReplicationLag('postImages', props.postId);
  await bustCachesForPost(props.postId);

  return image;
};

export async function bustCachesForPost(postId: number) {
  const [result] = await dbRead.$queryRaw<{ isShowcase: boolean; modelVersionId: number }[]>`
    SELECT m."userId" = p."userId" as "isShowcase",
           p."modelVersionId"
    FROM "Post" p
           JOIN "ModelVersion" mv ON mv."id" = p."modelVersionId"
           JOIN "Model" m ON m."id" = mv."modelId"
    WHERE p."id" = ${postId}
  `;

  if (result?.isShowcase) {
    await deleteImagesForModelVersionCache(result.modelVersionId);
  }
}

export const updatePostImage = async (image: UpdatePostImageInput) => {
  const currentImage = await dbWrite.image.findUnique({
    where: { id: image.id },
    select: { hideMeta: true },
  });

  const result = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: image.meta !== null ? (image.meta as Prisma.JsonObject) : Prisma.JsonNull,
    },
    select: { id: true, url: true, userId: true },
  });

  // If changing hide meta, purge the resize cache so that we strip metadata
  if (image.hideMeta && currentImage && currentImage.hideMeta !== image.hideMeta) {
    await purgeResizeCache({ url: result.url });
  }

  purgeImageGenerationDataCache(image.id);
  await userContentOverviewCache.bust(result.userId);
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

  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { postId: true, meta: true, resourceHelper: true, type: true },
  });

  if (images.length !== imageIds.length) {
    throw throwNotFoundError(`Image${imageIds.length > 1 ? 's' : ''} not found.`);
  }
  // TODO technically this can be called with a combo of on/off site imgs
  if (images.some((i) => i.type !== MediaType.video && isMadeOnSite(i.meta as ImageMetaProps))) {
    throw throwBadRequestError('Cannot add resources to on-site generations.');
  }

  const simpleResourceLimit = 8;
  const baseAxiom = {
    type: 'warning',
    name: 'fetch-generation-status',
    path: 'post.addResourceToImage',
  };

  let resourceLimit = simpleResourceLimit;
  try {
    const genStatus = await getGenerationStatus();
    if (genStatus) {
      const tier = user?.tier ?? 'free';
      if (isDefined(genStatus.limits?.[tier]?.resources)) {
        resourceLimit = genStatus.limits[tier].resources ?? simpleResourceLimit;
      } else {
        logToAxiom({
          ...baseAxiom,
          message: 'no resource limit found',
        }).catch();
      }
    } else {
      logToAxiom({
        ...baseAxiom,
        message: 'no gen status',
      }).catch();
    }
  } catch (e: unknown) {
    const error = e as Error;
    logToAxiom({
      ...baseAxiom,
      message: error?.message,
    }).catch();
  }

  images.forEach((img) => {
    const numExistingResources = img.resourceHelper.length;
    if (numExistingResources >= resourceLimit) {
      throw throwBadRequestError(`Maximum resources reached (${resourceLimit})`);
    }
  });

  // TODO restrictions on allowedTypes

  // noinspection JSPotentiallyInvalidTargetOfIndexedPropertyAccess
  const hash = modelVersion.files?.[0]?.hashes?.[0]?.hash?.toLowerCase();
  const name = `${modelVersion.model.name} - ${modelVersion.name}`;

  const createdResources = await dbWrite.imageResource.createManyAndReturn({
    data: imageIds.map((imageId) => ({
      modelVersionId,
      imageId,
      name,
      hash,
      detected: false,
    })),
    skipDuplicates: true,
    select: { id: true, imageId: true },
  });

  if (createdResources.length > 0) {
    await queueImageSearchIndexUpdate({
      ids: uniq(createdResources.map((x) => x.imageId)),
      action: SearchIndexUpdateQueueAction.Update,
    });
  }

  // TODO are these necessary?
  // - Cache Busting

  await bustCacheTag(`images-user:${user.id}`);
  await bustCacheTag(`images-modelVersion:${modelVersionId}`);
  await bustCacheTag(`images-model:${modelVersion.model.id}`);

  // for (const imageId of imageIds) {
  //   purgeImageGenerationDataCache(imageId);
  // }

  for (const image of images) {
    if (!!image.postId) {
      await preventReplicationLag('postImages', image.postId);
      await bustCachesForPost(image.postId);
    }
  }

  return dbWrite.imageResourceHelper.findMany({
    where: { id: { in: createdResources.map((x) => x.id) } },
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

  // nb: possible issue with deduped "name" field?
  const resource = await dbWrite.imageResource.findFirst({
    where: { imageId, modelVersionId },
  });

  if (!resource) throw throwNotFoundError('Image resource not found.');

  const deleted = await dbWrite.imageResource.delete({
    where: { id: resource.id },
  });

  await queueImageSearchIndexUpdate({
    ids: [imageId],
    action: SearchIndexUpdateQueueAction.Update,
  });

  // TODO are these necessary?
  // - Cache Busting

  await bustCacheTag(`images-user:${user.id}`);
  await bustCacheTag(`images-modelVersion:${modelVersionId}`);
  // await bustCacheTag(`images-model:${modelVersion.model.id}`);

  // for (const imageId of imageIds) {
  //   purgeImageGenerationDataCache(imageId);
  // }

  if (!!image.postId) {
    await preventReplicationLag('postImages', image.postId);
    await bustCachesForPost(image.postId);
  }

  return deleted;
};

export const reorderPostImages = async ({ id: postId, imageIds }: ReorderPostImagesInput) => {
  const transaction = await dbWrite.$transaction(
    imageIds.map((id, index) => dbWrite.image.update({ where: { id, postId }, data: { index } }))
  );

  await updatePostNsfwLevel(postId);
  await bustCachesForPost(postId);

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
