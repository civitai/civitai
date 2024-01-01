import {
  Availability,
  CollectionContributorPermission,
  CollectionReadConfiguration,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  NsfwLevel,
  Prisma,
  TagTarget,
  TagType,
} from '@prisma/client';
import { SessionUser } from 'next-auth';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import {
  applyModRulesSql,
  applyUserPreferencesSql,
  deleteImageById,
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
  GetPostsByCategoryInput,
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
import { profileImageSelect } from '../selectors/image.selector';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
import { getClubDetailsForResource, upsertClubResource } from './club.service';
import { entityRequiresClub, hasEntityAccess } from './common.service';
import { env } from 'process';
import { CacheTTL } from '../common/constants';
import { getPrivateEntityAccessForUser } from './user-cache.service';

type GetAllPostsRaw = {
  id: number;
  nsfw: boolean;
  title: string | null;
  userId: number;
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
  profilePictureId: number | null;
  publishedAt: Date | null;
  cursorId: Date | number | null;
  unlisted: boolean;
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
  browsingMode,
}: Omit<PostsQueryInput, 'include'> & {
  user?: { id: number; isModerator?: boolean; username?: string };
  ignoreListedStatus?: boolean;
  include?: string[];
}) => {
  const AND = [Prisma.sql`1 = 1`];
  const WITH: Prisma.Sql[] = [];
  const cacheTags: string[] = [];
  let cacheTime = CacheTTL.xs;

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

    // We could techically do this on the FE.
    if (browsingMode === BrowsingMode.SFW) {
      AND.push(Prisma.sql`p."nsfw" = false`);
    }

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

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;

  const postsRawQuery = Prisma.sql`
    ${queryWith}
    SELECT
      p.id,
      p.nsfw,
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
        excludedIds: excludedImageIds,
        userId: user?.id,
        isOwnerRequest,
      })
    : [];

  // Get user cosmetics
  const userIds = postsRaw.map((i) => i.userId);
  const userCosmetics = include?.includes('cosmetics')
    ? await getCosmeticsForUsers(userIds)
    : undefined;

  const profilePictures = await getProfilePicturesForUsers(userIds);

  const clubRequirement = await entityRequiresClub({
    entityType: 'Post',
    entityIds: postsRaw.map(({ id }) => id),
  });

  const userEntityAccess = await getPrivateEntityAccessForUser({ userId: user?.id });
  const privatePostAccessIds = userEntityAccess
    .filter((x) => x.entityType === 'Post')
    .map((x) => x.entityId);

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
        // Allow mods and owners to view all.
        if (user?.isModerator || p.userId === user?.id) return true;

        // Hide posts where the user does not have permission.
        if (
          p.unlisted &&
          p.availability === Availability.Private &&
          !privatePostAccessIds.includes(p.id)
        ) {
          return false;
        }

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
        const { imageCount, ...image } =
          images.find((x) => x.postId === post.id) ?? ({ imageCount: 0 } as (typeof images)[0]);

        return {
          ...post,
          imageCount: Number(imageCount ?? 0),
          user: {
            id: creatorId,
            username,
            image: userImage,
            deletedAt,
            cosmetics: userCosmetics?.[creatorId] ?? [],
            profilePicture: profilePictures[creatorId] ?? null,
          },
          stats,
          image,
          clubRequirement: clubRequirement.find((r) => r.entityId === post.id),
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
      nsfw: true,
      title: true,
      detail: true,
      modelVersionId: true,
      user: { select: userWithCosmeticsSelect },
      publishedAt: true,
      tags: { select: { tag: { select: simpleTagSelect } } },
    },
  });

  if (!post) throw throwNotFoundError();

  const [access] = await hasEntityAccess({
    userId: user?.id,
    isModerator: user?.isModerator,
    entityIds: [id],
    entityType: 'Post',
  });

  return {
    ...post,
    detail: access?.hasAccess ?? true ? post.detail : null,
    tags: post.tags.flatMap((x) => x.tag),
    hasAccess: access.hasAccess,
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

  const [entityClubDetails] = await getClubDetailsForResource({
    entityType: 'Post',
    entityIds: [post.id],
  });

  return {
    ...castedPost,
    tags: castedPost.tags.flatMap((x) => x.tag),
    clubs: entityClubDetails?.clubs ?? [],
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

  const [entityClubDetails] = await getClubDetailsForResource({
    entityType: 'Post',
    entityIds: [result.id],
  });

  return {
    ...result,
    tags: result.tags.flatMap((x) => x.tag),
    clubs: entityClubDetails?.clubs ?? [],
  };
};

export const updatePost = async ({
  id,
  clubs,
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

  if (post && clubs && userId) {
    // Update the resource itself:
    await upsertClubResource({
      userId,
      isModerator,
      entityId: post.id,
      entityType: 'Post',
      clubs: clubs ?? [],
    });
  }

  return post;
};

export const deletePost = async ({ id }: GetByIdInput) => {
  const images = await dbWrite.image.findMany({ where: { postId: id } });
  if (images.length) {
    for (const image of images) await deleteImageById({ id: image.id });
  }

  await dbWrite.clubPost.deleteMany({
    where: { entityId: id, entityType: 'Post' },
  });

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
      t."isCategory",
      COALESCE(${
        showTrending ? Prisma.sql`s."postCountDay"` : Prisma.sql`s."postCountAllTime"`
      }, 0)::int AS "postCount"
    FROM "Tag" t
    LEFT JOIN "TagStat" s ON s."tagId" = t.id
    LEFT JOIN "TagRank" r ON r."tagId" = t.id
    WHERE
      ${showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`}
    ORDER BY ${Prisma.raw(
      showTrending ? `r."postCountDayRank" DESC` : `LENGTH(t.name), r."postCountAllTimeRank" DESC`
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

  return image;
};

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

export const reorderPostImages = async ({ id, imageIds }: ReorderPostImagesInput) => {
  const transaction = await dbWrite.$transaction(
    imageIds.map((id, index) => dbWrite.image.update({ where: { id }, data: { index } }))
  );

  await updatePostNsfwLevel(id);

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

type GetPostByCategoryRaw = {
  id: number;
  tagId: number;
  nsfw: boolean;
  title: string | null;
  detail: string | null;
  username: string | null;
  userImage: string | null;
  modelVersionId: number | null;
  createdAt: Date;
  publishedAt: Date | null;
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
};
type PostImageRaw = {
  id: number;
  name: string;
  url: string;
  nsfw: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  meta: Prisma.JsonValue;
  hideMeta: boolean;
  generationProcess: ImageGenerationProcess;
  createdAt: Date;
  type: MediaType;
  metadata: Prisma.JsonValue;
  scannedAt: Date;
  needsReview: string | null;
  postId: number;
};
export const getPostsByCategory = async ({
  userId,
  ...input
}: GetPostsByCategoryInput & { userId?: number }) => {
  input.limit ??= 10;

  let categories = await getTypeCategories({
    type: 'post',
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor: input.cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;
  categories = categories.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.random() - 0.5;
  });

  const AND = [Prisma.sql`1 = 1`];

  // Apply excluded tags
  if (input.excludedTagIds?.length)
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnPost" top
      WHERE top."postId" = p.id
      AND top."tagId" IN (${Prisma.join(input.excludedTagIds)})
    )`);

  // Apply excluded users
  if (input.excludedUserIds?.length)
    AND.push(Prisma.sql`p."userId" NOT IN (${Prisma.join(input.excludedUserIds)})`);

  // Limit to selected user
  if (input.username) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: input.username },
      select: { id: true },
    });
    if (!targetUser) throw new Error('User not found');
    AND.push(Prisma.sql`p."userId" = ${targetUser.id}`);
  }

  // Limit to selected model/version
  if (input.modelId) AND.push(Prisma.sql`mv."modelId" = ${input.modelId}`);
  if (input.modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${input.modelVersionId}`);

  // Apply SFW filter
  if (input.browsingMode === BrowsingMode.SFW) AND.push(Prisma.sql`p."nsfw" = false`);

  let orderBy = `p."publishedAt" DESC NULLS LAST`;
  if (input.sort === PostSort.MostReactions)
    orderBy = `pm."likeCount"+pm."heartCount"+pm."laughCount"+pm."cryCount" DESC NULLS LAST, ${orderBy}`;
  else if (input.sort === PostSort.MostComments)
    orderBy = `pm."commentCount" DESC NULLS LAST, ${orderBy}`;

  const targets = categories.map((c) => {
    return Prisma.sql`(
      SELECT
        top."postId", "tagId", row_number() OVER (ORDER BY ${Prisma.raw(orderBy)}) "index"
      FROM "TagsOnPost" top
      JOIN "Post" p ON p.id = top."postId"
        ${Prisma.raw(
          input.period !== 'AllTime' && input.periodMode !== 'stats'
            ? `AND p."publishedAt" > now() - INTERVAL '1 ${input.period}'`
            : 'AND p."publishedAt" < now()'
        )}
      ${Prisma.raw(input.modelId ? `JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"` : '')}
      ${Prisma.raw(
        orderBy.startsWith('pm')
          ? `LEFT JOIN "PostMetric" pm ON pm."postId" = top."postId" AND pm.timeframe = '${input.period}'`
          : ''
      )}
      WHERE top."tagId" = ${c.id}
      AND ${Prisma.join(AND, ' AND ')}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${input.postLimit ?? 21}
    )`;
  });

  const postsRaw = await dbRead.$queryRaw<GetPostByCategoryRaw[]>`
    WITH targets AS (
      ${Prisma.join(targets, ' UNION ALL ')}
    )
    SELECT
      p.id,
      t."tagId",
      p.nsfw,
      p.title,
      p.detail,
      u.username,
      u.image AS "userImage",
      p."modelVersionId",
      p."createdAt",
      p."publishedAt",
      COALESCE(pm."cryCount", 0) "cryCount",
      COALESCE(pm."laughCount", 0) "laughCount",
      COALESCE(pm."likeCount", 0) "likeCount",
      COALESCE(pm."dislikeCount", 0) "dislikeCount",
      COALESCE(pm."heartCount", 0) "heartCount",
      COALESCE(pm."commentCount", 0) "commentCount"
    FROM targets t
    JOIN "Post" p ON p.id = t."postId"
    JOIN "User" u ON u.id = p."userId"
    LEFT JOIN "PostMetric" pm ON pm."postId" = p.id AND pm."timeframe" = 'AllTime'::"MetricTimeframe"
    ORDER BY t."index"
  `;

  let images: PostImageRaw[] = [];
  const postIds = postsRaw.map((p) => p.id);
  if (postIds.length) {
    const imageAND = [Prisma.sql`"postId" IN (${Prisma.join(postIds)})`];

    // ensure that only scanned images make it to the main feed
    imageAND.push(
      Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );

    applyUserPreferencesSql(imageAND, { ...input, userId });
    applyModRulesSql(imageAND, { userId });
    images = await dbRead.$queryRaw<PostImageRaw[]>`
      WITH all_images AS (
        SELECT
          i.id,
          i.name,
          i.url,
          i.nsfw,
          i.width,
          i.height,
          i.hash,
          i.meta,
          i.type,
          i.metadata,
          i."hideMeta",
          i."generationProcess",
          i."createdAt",
          i."scannedAt",
          i."needsReview",
          i."postId",
          row_number() OVER (PARTITION BY i."postId" ORDER BY i."index") row_number
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE ${Prisma.join(imageAND, ' AND ')}
      )
      SELECT
        *
      FROM all_images
      ORDER BY row_number;
    `;
  }

  // Convert raw to processed
  const usedImages = new Set();
  const rawToProcess = (raw: GetPostByCategoryRaw) => {
    const postImages = images.filter((i) => i.postId === raw.id);
    const image = postImages.find((i) => !usedImages.has(i.id));
    if (!image) return null;
    usedImages.add(image.id);
    return {
      ...raw,
      imageCount: postImages.length,
      image,
    };
  };

  // Map posts to categories
  const postCategories: Record<number, ReturnType<typeof rawToProcess>[]> = {};
  for (const raw of postsRaw) {
    const processed = rawToProcess(raw);
    if (!processed) continue;
    if (!postCategories[raw.tagId]) postCategories[raw.tagId] = [];
    postCategories[raw.tagId].push(processed);
  }

  // Map category record to array
  const items = categories
    .map((c) => {
      const items = postCategories[c.id]?.filter(isDefined) ?? [];
      // Let's include empty categories for now
      // if (!items.length) return null;
      return { ...c, items };
    })
    .filter(isDefined);

  return { items, nextCursor };
};
