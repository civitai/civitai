import {
  Availability,
  CollectionContributorPermission,
  CollectionReadConfiguration,
  Prisma,
  TagTarget,
  TagType,
} from '@prisma/client';
import { SessionUser } from 'next-auth';
import { NsfwLevel, PostSort } from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ImageMetaProps, getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import {
  deleteImageById,
  deleteImagesForModelVersionCache,
  getImagesForPosts,
  ingestImage,
} from '~/server/services/image.service';
import { getTagCountForImages, getTypeCategories } from '~/server/services/tag.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import {
  AddPostImageInput,
  AddPostTagInput,
  GetPostTagsInput,
  PostCreateInput,
  PostsQueryInput,
  PostUpdateInput,
  RemovePostTagInput,
  ReorderPostImagesInput,
  UpdatePostImageInput,
} from './../schema/post.schema';
import { editPostSelect } from './../selectors/post.selector';
import { postgresSlugify } from '~/utils/string-helpers';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
import { env } from 'process';
import { CacheTTL } from '../common/constants';
import { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';

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
  cosmetic?: BadgeCosmetic | null;
};
export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];
export const getPostsInfinite = async ({
  limit,
  cursor,
  query,
  username,
  excludedImageIds,
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

  const joins: string[] = [];
  if (!isOwnerRequest) {
    AND.push(Prisma.sql`p."publishedAt" < now()`);
    AND.push(Prisma.sql`p.metadata->>'unpublishedAt' IS NULL`);

    if (period !== 'AllTime' && periodMode !== 'stats') {
      AND.push(Prisma.raw(`p."publishedAt" > now() - INTERVAL '1 ${period.toLowerCase()}'`));
    }

    if (!!tags?.length)
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "TagsOnPost" top
        WHERE top."postId" = p.id AND top."tagId" IN (${Prisma.join(tags)})
      )`);

    if (query) {
      AND.push(Prisma.sql`p.title ILIKE ${query + '%'}`);
    }
  } else {
    if (draftOnly) AND.push(Prisma.sql`p."publishedAt" IS NULL`);
    else AND.push(Prisma.sql`p."publishedAt" IS NOT NULL`);
    AND.push(Prisma.sql`p.metadata->>'unpublishedAt' IS NULL`);
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

  // sorting
  let orderBy = 'p."publishedAt" DESC NULLS LAST';
  if (sort === PostSort.MostComments) orderBy = `r."commentCount${period}Rank"`;
  else if (sort === PostSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;
  else if (sort === PostSort.MostCollected) orderBy = `r."collectedCount${period}Rank"`;
  const includeRank = orderBy.startsWith('r.');
  if (includeRank) {
    const optionalRank = !!(username || modelVersionId || ids || collectionId);
    joins.push(`${optionalRank ? 'LEFT ' : ''}JOIN "PostRank" r ON r."postId" = p.id`);
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

  if (includeCosmetics) {
    WITH.push(Prisma.sql`
      "postCosmetic" AS (
        SELECT
          c.id,
          c.data,
          uc."equippedToId"
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."equippedToType" = 'Post' AND c.type = 'ContentDecoration'
      )
    `);
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
      (
        SELECT jsonb_build_object(
          'cryCount', COALESCE(pm."cryCount", 0),
          'laughCount', COALESCE(pm."laughCount", 0),
          'likeCount', COALESCE(pm."likeCount", 0),
          'dislikeCount', COALESCE(pm."dislikeCount", 0),
          'heartCount', COALESCE(pm."heartCount", 0),
          'commentCount', COALESCE(pm."commentCount", 0)
        ) "stats"
        FROM "PostMetric" pm
        WHERE pm."postId" = p.id AND pm."timeframe" = ${period}::"MetricTimeframe"
      ) "stats",
      ${
        includeCosmetics
          ? Prisma.raw(`
              (
                SELECT jsonb_build_object(
                  'id', pc.id,
                  'data', pc.data
                ) FROM "postCosmetic" pc WHERE pc."equippedToId" = p.id
              ) as "cosmetic",
            `)
          : Prisma.empty
      }
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
  const userCosmetics = include?.includes('cosmetics')
    ? await getCosmeticsForUsers(userIds)
    : undefined;

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
        };
      })
      .filter((x) => x.imageCount !== 0),
  };
};

export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const post = await dbRead.post.findFirst({
    where: {
      id,
      OR: user?.isModerator
        ? undefined
        : [
            { publishedAt: { lt: new Date() } },
            { userId: user?.id },
            { modelVersionId: null },
            { modelVersion: { status: 'Published' } },
          ],
      // modelVersion: user?.isModerator ? undefined : { status: 'Published' },
    },
    select: {
      id: true,
      nsfwLevel: true,
      title: true,
      detail: true,
      modelVersionId: true,
      user: { select: userWithCosmeticsSelect },
      publishedAt: true,
      availability: true,
      tags: { select: { tag: { select: simpleTagSelect } } },
    },
  });

  if (!post) throw throwNotFoundError();

  return {
    ...post,
    detail: post.detail,
    tags: post.tags.flatMap((x) => x.tag),
  };
};

export const getPostEditDetail = async ({ id }: GetByIdInput) => {
  const postRaw = await dbWrite.post.findUnique({
    where: { id },
    select: editPostSelect,
  });
  if (!postRaw) throw throwNotFoundError();

  const { images: rawImages, ...post } = postRaw;
  const imageIds = rawImages.map((x) => x.id);
  const imageTagCounts = await getTagCountForImages(imageIds);
  const images = rawImages.map((x) => ({
    ...x,
    meta: x.meta as ImageMetaProps | null,
    _count: { tags: imageTagCounts[x.id] },
  }));

  const castedPost = {
    ...post,
    images,
  };

  return {
    ...castedPost,
    tags: castedPost.tags.flatMap((x) => x.tag),
  };
};

export const createPost = async ({
  userId,
  tag,
  ...data
}: PostCreateInput & { userId: number }) => {
  const rawResult = await dbWrite.post.create({
    data: { ...data, userId, tags: tag ? { create: { tagId: tag } } : undefined },
    select: editPostSelect,
  });
  const imageIds = rawResult.images.map((x) => x.id);
  const imageTagCounts = await getTagCountForImages(imageIds);
  const images = rawResult.images.map((x) => ({
    ...x,
    meta: x.meta as ImageMetaProps,
    _count: { tags: imageTagCounts[x.id] },
  }));

  const result = {
    ...rawResult,
    images,
  };

  return {
    ...result,
    tags: result.tags.flatMap((x) => x.tag),
  };
};

export const updatePost = async ({
  id,
  userId,
  isModerator,
  ...data
}: PostUpdateInput & { userId?: number; isModerator?: boolean }) => {
  const post = await dbWrite.post.update({
    where: { id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: data.detail !== undefined ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });

  return post;
};

export const deletePost = async ({ id }: GetByIdInput) => {
  const images = await dbWrite.image.findMany({ where: { postId: id } });
  if (images.length) {
    for (const image of images) await deleteImageById({ id: image.id, updatePost: false });
  }

  await dbWrite.clubPost.deleteMany({
    where: { entityId: id, entityType: 'Post' },
  });

  await bustCachesForPost(id);
  await dbWrite.post.delete({ where: { id } });
};

type PostQueryResult = { id: number; name: string; isCategory: boolean; postCount: number }[];
export const getPostTags = async ({
  query,
  limit,
  excludedTagIds,
}: GetPostTagsInput & { excludedTagIds?: number[] }) => {
  const showTrending = query === undefined || query.length < 2;
  const tags = await dbRead.$queryRaw<PostQueryResult>`
    SELECT
      t.id,
      t.name,
      (
        SELECT COALESCE(
        (
            SELECT MAX(pt."nsfwLevel")
            FROM "TagsOnTags" tot
            JOIN "Tag" pt ON tot."fromTagId" = pt.id
            WHERE tot."toTagId" = t.id
        ), t."nsfwLevel") "nsfwLevel"
      ) "nsfwLevel",
      t."isCategory",
      COALESCE(${
        showTrending ? Prisma.sql`s."postCountWeek"` : Prisma.sql`s."postCountAllTime"`
      }, 0)::int AS "postCount"
    FROM "Tag" t
    LEFT JOIN "TagStat" s ON s."tagId" = t.id
    LEFT JOIN "TagRank" r ON r."tagId" = t.id
    WHERE
      ${showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`}
    ORDER BY ${Prisma.raw(
      showTrending ? `r."postCountWeekRank" ASC` : `r."postCountAllTimeRank" ASC`
    )}
    LIMIT ${limit}
  `;

  return (
    !!excludedTagIds?.length ? tags.filter((x) => !excludedTagIds.includes(x.id)) : tags
  ).sort((a, b) => b.postCount - a.postCount);
};

export const addPostTag = async ({ tagId, id: postId, name: initialName }: AddPostTagInput) => {
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

export const addPostImage = async ({
  modelVersionId,
  meta,
  ...props
}: AddPostImageInput & { userId: number }) => {
  const partialResult = await dbWrite.image.create({
    data: {
      ...props,
      meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: meta ? getImageGenerationProcess(meta as Prisma.JsonObject) : null,
    },
    select: { id: true },
  });

  await dbWrite.$executeRaw`SELECT insert_image_resource(${partialResult.id}::int)`;
  await ingestImage({
    image: {
      id: partialResult.id,
      url: props.url,
      type: props.type,
      height: props.height,
      width: props.width,
    },
  });

  const image = await dbWrite.image.findUnique({
    where: { id: partialResult.id },
    select: editPostImageSelect,
  });
  if (!image) throw throwDbError(`Image not found`);

  const modelVersionIds = image.resourceHelper.map((r) => r.modelVersionId).filter(isDefined);
  // Cache Busting
  await bustCacheTag(`images-user:${props.userId}`);
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

  await bustCachesForPost(props.postId);

  return image;
};

export async function bustCachesForPost(postId: number) {
  const [result] = await dbRead.$queryRaw<{ isShowcase: boolean; modelVersionId: number }[]>`
    SELECT
      m."userId" = p."userId" as "isShowcase",
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
  // const updateResources = image.resources.filter(isImageResource);
  // const createResources = image.resources.filter(isNotImageResource);

  const rawResult = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      // resources: {
      //   deleteMany: {
      //     NOT: updateResources.map((r) => ({ id: r.id })),
      //   },
      //   createMany: { data: createResources.map((r) => ({ modelVersionId: r.id, name: r.name })) },
      // },
    },
    select: editPostImageSelect,
  });
  const imageTags = await getTagCountForImages([image.id]);

  return {
    ...rawResult,
    meta: rawResult.meta as ImageMetaProps | null,
    _count: { tags: imageTags[image.id] },
  };
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
