import { GetByIdInput } from '~/server/schema/base.schema';
import { SessionUser } from 'next-auth';
import { getSystemTags } from '~/server/services/system-cache';
import { editPostSelect } from './../selectors/post.selector';
import { isDefined } from '~/utils/type-guards';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  PostUpdateInput,
  AddPostTagInput,
  AddPostImageInput,
  UpdatePostImageInput,
  PostCreateInput,
  ReorderPostImagesInput,
  RemovePostTagInput,
  GetPostTagsInput,
  PostsQueryInput,
  GetPostsByCategoryInput,
} from './../schema/post.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  TagType,
  TagTarget,
  Prisma,
  ImageGenerationProcess,
  NsfwLevel,
  ImageIngestionStatus,
} from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import {
  applyModRulesSql,
  applyUserPreferencesSql,
  deleteImageById,
  getImagesForPosts,
  ingestImage,
} from '~/server/services/image.service';
import { getTagCountForImages, getTypeCategories } from '~/server/services/tag.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getCosmeticsForUsers } from '~/server/services/user.service';

type GetAllPostsRaw = {
  id: number;
  nsfw: boolean;
  title: string | null;
  userId: number;
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
  publishedAt: Date | null;
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
  excludedTagIds,
  excludedUserIds,
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
}: PostsQueryInput & { user?: SessionUser }) => {
  const AND = [Prisma.sql`1 = 1`];

  const isOwnerRequest = user && user.username === username;
  if (username) {
    const targetUser = await dbRead.user.findFirst({ where: { username }, select: { id: true } });
    if (targetUser) AND.push(Prisma.sql`p."userId" = ${targetUser.id}`);
  }
  if (modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
  if (!isOwnerRequest) {
    AND.push(Prisma.sql`p."publishedAt" < now()`);
    if (period !== 'AllTime' && periodMode !== 'stats') {
      AND.push(Prisma.raw(`p."publishedAt" > now() - INTERVAL '1 ${period.toLowerCase()}'`));
    }
    if (query) AND.push(Prisma.sql`p.title ILIKE ${query + '%'}`);
    if (!!excludedTagIds?.length) {
      const excludedOr = [
        Prisma.sql`NOT EXISTS (
          SELECT 1 FROM
          "TagsOnPost" top
          WHERE top."postId" = p.id
          AND top."tagId" IN (${Prisma.join(excludedTagIds)})
        ) AND EXISTS (
          SELECT 1 FROM "Image" i
          WHERE i."postId" = p.id AND i."ingestion" = 'Scanned'
        )`,
      ];
      if (user?.id) excludedOr.push(Prisma.sql`p."userId" = ${user.id}`);
      AND.push(Prisma.sql`(${Prisma.join(excludedOr, ' OR ')})`);
    }
    if (!!tags?.length)
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "TagsOnPost" top
        WHERE top."postId" = p.id AND top."tagId" IN (${Prisma.join(tags)})
      )`);

    if (!!excludedUserIds?.length)
      AND.push(Prisma.sql`p."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
    if (!user?.isModerator) {
      // Handle Post Visibility
      AND.push(Prisma.sql`p."modelVersionId" IS NULL OR EXISTS (
        SELECT 1 FROM "ModelVersion" mv
        WHERE mv.id = p."modelVersionId" AND mv.status = 'Published'
      )`);

      // Handle Collection Visibility
      const collectionOr = [
        Prisma.sql`p."collectionId" IS NULL`,
        Prisma.sql`EXISTS (
        SELECT 1 FROM "Collection" c
        WHERE c.id = p."collectionId" AND c.read = 'Public'
      )`,
      ];
      if (user?.id)
        collectionOr.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "CollectionContributor" cc
          WHERE cc."collectionId" = p."collectionId" AND cc."userId" = ${user?.id} AND 'VIEW' = ANY(cc.permissions)'
        )`);

      AND.push(Prisma.sql`(${Prisma.join(collectionOr, ' OR ')})`);
    }
  }
  if (ids) AND.push(Prisma.sql`p.id IN (${Prisma.join(ids)})`);
  if (collectionId) {
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
        AND ci."imageId" = i.id
        AND (ci."status" = 'ACCEPTED' ${Prisma.raw(displayReviewItems)})
    )`);
  }

  // sorting
  let orderBy = 'p."publishedAt" DESC NULLS LAST';
  if (sort === PostSort.MostComments) orderBy = `r."comment${period}Rank"`;
  else if (sort === PostSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;
  const includeRank = orderBy.startsWith('r.');
  const optionalRank = !!(username || modelVersionId || ids || collectionId);

  // cursor
  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    const cursorValue = cursorProp === 'p."publishedAt"' ? new Date(cursor) : Number(cursor);
    if (cursorProp) AND.push(Prisma.sql`${cursorProp} ${cursorOperator} ${cursorValue}`);
  }

  const postsRaw = await dbRead.$queryRaw<GetAllPostsRaw[]>`
    SELECT
      p.id,
      p.nsfw,
      p.title,
      p."userId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      p."publishedAt",
      (
        SELECT jsonb_build_object(
          'cryCount', pm."cryCount",
          'laughCount', pm."laughCount",
          'likeCount', pm."likeCount",
          'dislikeCount', pm."dislikeCount",
          'heartCount', pm."heartCount",
          'commentCount', pm."commentCount"
        ) "stats"
        FROM "PostMetric" pm
        WHERE pm."postId" = p.id AND pm."timeframe" = ${period}::"MetricTimeframe"
      ) "stats",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
    FROM "Post" p
    JOIN "User" u ON u.id = p."userId"
    ${Prisma.raw(
      includeRank ? `${optionalRank ? 'LEFT ' : ''}JOIN "PostRank" r ON r."postId" = p.id` : ''
    )}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit + 1}`;

  let nextCursor: number | undefined;
  if (postsRaw.length > limit) {
    const nextItem = postsRaw.pop();
    nextCursor = nextItem?.id;
  }

  const images = postsRaw.length
    ? await getImagesForPosts({
        postIds: postsRaw.map((x) => x.id),
        excludedTagIds,
        excludedUserIds,
        excludedIds: excludedImageIds,
        userId: user?.id,
        isOwnerRequest,
      })
    : [];

  // Get user cosmetics
  const userCosmetics = include?.includes('cosmetics')
    ? await getCosmeticsForUsers(postsRaw.map((i) => i.userId))
    : undefined;

  return {
    nextCursor,
    items: postsRaw
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
            cosmetics: userCosmetics?.[creatorId]?.map((cosmetic) => ({ cosmetic })) ?? [],
          },
          stats,
          image,
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
  return {
    ...post,
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

export const updatePost = ({ id, ...data }: PostUpdateInput) => {
  return dbWrite.post.update({
    where: { id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: data.detail !== undefined ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });
};

export const deletePost = async ({ id }: GetByIdInput) => {
  const images = await dbWrite.image.findMany({ where: { postId: id } });
  if (images.length) {
    for (const image of images) await deleteImageById({ id: image.id });
  }
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
  await ingestImage({ image: { id: partialResult.id, url: props.url } });

  const image = await dbWrite.image.findUnique({
    where: { id: partialResult.id },
    select: editPostImageSelect,
  });
  if (!image) throw throwDbError(`Image not found`);

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

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: { id: true } })
    )
  );

  return transaction;
};

export const getPostResources = async ({ id }: GetByIdInput) => {
  return await dbRead.postResourceHelper.findMany({
    where: { postId: id },
    orderBy: { modelName: 'asc' },
  });
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
  mimeType: string;
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
          i."hideMeta",
          i."generationProcess",
          i."createdAt",
          i."mimeType",
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
