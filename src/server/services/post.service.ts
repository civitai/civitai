import { SessionUser } from 'next-auth';
import { isNotImageResource } from './../schema/image.schema';
import { editPostSelect, postTagSelect } from './../selectors/post.selector';
import { isDefined } from '~/utils/type-guards';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { GetByIdInput } from './../schema/base.schema';
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
import { env } from '~/env/server.mjs';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { BrowsingMode } from '~/server/common/enums';
import { getImageV2Select } from '~/server/selectors/imagev2.selector';
import { getHiddenTagsForUser } from '~/server/services/user-cache.service';

export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];
export const getPostsInfinite = async ({
  page,
  limit,
  cursor,
  query,
  username,
  excludedTagIds,
  excludedUserIds,
  period,
  sort,
  user,
}: PostsQueryInput & { user?: SessionUser }) => {
  const skip = (page - 1) * limit;
  const take = limit + 1;

  const AND: Prisma.Enumerable<Prisma.PostWhereInput> = [];
  const imageAND: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (query) AND.push({ title: { in: query, mode: 'insensitive' } });
  if (username) AND.push({ user: { username } });
  if (!!excludedTagIds?.length) {
    AND.push({ tags: { none: { tagId: { in: excludedTagIds } } } });
    imageAND.push({ tags: { none: { tagId: { in: excludedTagIds } } } });
  }
  if (!!excludedUserIds?.length) AND.push({ user: { id: { notIn: excludedUserIds } } });

  const posts = await dbRead.post.findMany({
    skip,
    take,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      AND,
    },
    select: {
      id: true,
      nsfw: true,
      title: true,
      user: { select: userWithCosmeticsSelect },
      images: {
        orderBy: { index: 'asc' },
        take: 1,
        select: getImageV2Select({ userId: user?.id }),
        where: {
          AND: imageAND,
        },
      },
    },
  });

  const postsWithImage = posts.filter((x) => !!x.images.length);
  let nextCursor: number | undefined;
  if (postsWithImage.length > limit) {
    const nextItem = postsWithImage.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: postsWithImage.map(({ images, ...post }) => ({
      ...post,
      image: images[0],
    })),
  };
};

export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const hiddenTags = user?.isModerator ? [] : await getHiddenTagsForUser({ userId: user?.id });

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
      images: {
        orderBy: { index: 'asc' },
        select: getImageV2Select({ userId: user?.id }),
        where: {
          OR: [
            { userId: user?.id },
            { tags: !!hiddenTags.length ? { none: { tagId: { in: hiddenTags } } } : undefined },
          ],
        },
      },
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
    images: post.images.map((image) => ({ ...image, tags: image.tags.flatMap((x) => x.tag) })),
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
    images: result.images.map((image) => ({ ...image, tags: image.tags.flatMap((x) => x.tag) })),
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

export const getPostTags = async ({ query, limit }: GetPostTagsInput) => {
  const showTrending = query === undefined || query.length < 2;
  return await dbRead.tag.findMany({
    take: limit,
    where: {
      name: !showTrending ? { contains: query, mode: 'insensitive' } : undefined,
      rank: { isNot: null },
      isCategory: showTrending ? true : undefined,
    },
    select: postTagSelect({ trending: showTrending }),
    orderBy: {
      rank: !showTrending ? { postCountAllTimeRank: 'desc' } : { postCountDayRank: 'desc' },
    },
  });
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

const toInclude: ModelFileType[] = ['Model', 'Pruned Model', 'Negative'];
export const addPostImage = async ({
  resources,
  modelVersionId,
  ...image
}: AddPostImageInput & { userId: number }) => {
  const autoResources = !!resources?.length
    ? await dbWrite.modelFile.findMany({
        where: {
          type: { in: toInclude },
          hashes: {
            some: {
              hash: { in: resources, mode: 'insensitive' },
            },
          },
        },
        select: {
          modelVersionId: true,
        },
      })
    : [];

  const uniqueResources = [
    modelVersionId,
    ...new Set(autoResources.map((x) => x.modelVersionId)),
  ].filter(isDefined);

  const result = await dbWrite.image.create({
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: image.meta
        ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
        : null,
      resources: !!uniqueResources.length
        ? {
            create: uniqueResources.map((modelVersionId) => ({
              modelVersionId,
              detected: true,
            })),
          }
        : undefined,
    },
    select: editPostImageSelect,
  });
  return { ...result, tags: result.tags.flatMap((x) => x.tag) };
};

export const updatePostImage = async (image: UpdatePostImageInput) => {
  const updateResources = image.resources.filter(isImageResource);
  const createResources = image.resources.filter(isNotImageResource);

  const result = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      resources: {
        deleteMany: {
          NOT: updateResources.map((r) => ({ id: r.id })),
        },
        createMany: { data: createResources.map((r) => ({ modelVersionId: r.id, name: r.name })) },
      },
    },
    select: editPostImageSelect,
  });

  return { ...result, tags: result.tags.flatMap((x) => x.tag) };
};

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: { id: true } })
    )
  );

  return transaction;
};
