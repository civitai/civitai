import { GetByIdInput } from '~/server/schema/base.schema';
import { SessionUser } from 'next-auth';
import { isNotImageResource } from './../schema/image.schema';
import { editPostSelect } from './../selectors/post.selector';
import { isDefined } from '~/utils/type-guards';
import { throwNotFoundError } from '~/server/utils/errorHandling';
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
} from './../schema/post.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { TagType, TagTarget, Prisma } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { ModelFileType } from '~/server/common/constants';
import { isImageResource } from '~/server/schema/image.schema';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import { getImageV2Select } from '~/server/selectors/imagev2.selector';
import uniqWith from 'lodash/uniqWith';
import isEqual from 'lodash/isEqual';
import { getImagesForPosts } from '~/server/services/image.service';

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
  sort,
  user,
  tags,
}: PostsQueryInput & { user?: SessionUser }) => {
  const AND: Prisma.Enumerable<Prisma.PostWhereInput> = [];
  const orderBy: Prisma.Enumerable<Prisma.PostOrderByWithRelationInput> = [];
  const isOwnerRequest = user && user.username === username;
  if (username) AND.push({ user: { username } });
  if (isOwnerRequest) {
    orderBy.push({ id: 'desc' });
  } else {
    AND.push({ publishedAt: { not: null } });
    if (query) AND.push({ title: { in: query } });
    if (!!excludedTagIds?.length) {
      AND.push({
        OR: [
          { userId: user?.id },
          {
            tags: { none: { tagId: { in: excludedTagIds } } },
            helper: { scanned: true },
          },
        ],
      });
    }
    if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });
    if (!!excludedUserIds?.length) AND.push({ user: { id: { notIn: excludedUserIds } } });

    // sorting
    if (sort === PostSort.MostComments)
      orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
    else if (sort === PostSort.MostReactions)
      orderBy.push({ rank: { [`reactionCount${period}Rank`]: 'asc' } });
    orderBy.push({ publishedAt: 'desc' });
  }

  const posts = await dbRead.post.findMany({
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    orderBy,
    select: {
      id: true,
      nsfw: true,
      title: true,
      // user: { select: userWithCosmeticsSelect },
      publishedAt: true,
    },
  });

  const images = posts.length
    ? await getImagesForPosts({
        postIds: posts.map((x) => x.id),
        excludedTagIds,
        excludedUserIds,
        excludedIds: excludedImageIds,
        userId: user?.id,
      })
    : [];

  let nextCursor: number | undefined;
  if (posts.length > limit) {
    const nextItem = posts.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: posts
      .map((post) => ({
        ...post,
        image: images.find((x) => x.postId === post.id) as (typeof images)[0],
      }))
      .filter((x) => x.image !== undefined),
  };
};

export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const post = await dbRead.post.findUnique({
    where: { id },
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
  const post = await dbWrite.post.findUnique({
    where: { id },
    select: editPostSelect,
  });
  if (!post) throw throwNotFoundError();
  return {
    ...post,
    tags: post.tags.flatMap((x) => x.tag),
    images: post.images,
  };
};

export const createPost = async ({
  userId,
  modelVersionId,
}: PostCreateInput & { userId: number }) => {
  const result = await dbWrite.post.create({
    data: { userId, modelVersionId },
    select: editPostSelect,
  });
  return {
    ...result,
    tags: result.tags.flatMap((x) => x.tag),
    images: result.images,
  };
};

export const updatePost = async (data: PostUpdateInput) => {
  await dbWrite.post.updateMany({
    where: { id: data.id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: data.detail !== undefined ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });
};

export const deletePost = async ({ id }: GetByIdInput) => {
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

export const addPostTag = async ({ postId, id, name: initialName }: AddPostTagInput) => {
  const name = initialName.toLowerCase().trim();
  return await dbWrite.$transaction(async (tx) => {
    const tag = await tx.tag.findUnique({
      where: { name },
      select: { id: true, target: true },
    });
    if (!tag) {
      return await dbWrite.tag.create({
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
      return await dbWrite.tag.update({
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

export const removePostTag = async ({ postId, id }: RemovePostTagInput) => {
  await dbWrite.tagsOnPost.delete({ where: { tagId_postId: { tagId: id, postId } } });
};

export const addPostImage = async ({
  modelVersionId,
  meta,
  ...image
}: AddPostImageInput & { userId: number }) => {
  const partialResult = await dbWrite.image.create({
    data: {
      ...image,
      meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: meta ? getImageGenerationProcess(meta as Prisma.JsonObject) : null,
    select: { id: true },
  });

  await dbWrite.$executeRaw`SELECT insert_image_resource(${partialResult.id})`;

  const result = await dbWrite.image.findUnique({
    where: { id: partialResult.id },
    select: editPostImageSelect,
  });

  return result;
};

export const updatePostImage = async (image: UpdatePostImageInput) => {
  // const updateResources = image.resources.filter(isImageResource);
  // const createResources = image.resources.filter(isNotImageResource);

  const result = await dbWrite.image.update({
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

  return result;
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
