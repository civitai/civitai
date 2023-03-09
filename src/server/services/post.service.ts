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
} from './../schema/post.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { TagType, TagTarget, Prisma } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { editPostImageSelect, getPostDetailSelect } from '~/server/selectors/post.selector';
import { ModelFileType } from '~/server/common/constants';
import { isImageResource } from '~/server/schema/image.schema';

export const getPostDetail = async ({ id, userId }: GetByIdInput & { userId?: number }) => {
  const post = await dbWrite.post.findUnique({
    where: { id },
    select: getPostDetailSelect({ userId }),
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
  };
};

export const updatePost = async (data: PostUpdateInput) => {
  await dbWrite.post.update({
    where: { id: data.id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
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
    },
    select: postTagSelect({ trending: showTrending }),
    orderBy: {
      rank: !showTrending ? { postCountAllTimeRank: 'asc' } : { postCountDayRank: 'asc' },
    },
  });
};

export const addPostTag = async ({ postId, id, name: initialName }: AddPostTagInput) => {
  const name = initialName.toLowerCase().trim();
  if (!id) {
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
    });
  } else {
    // TODO.posts - revisit this. When a user is adding tags, will we display tags that aren't TagTarget.Post? If so, then we need to rethink this
    return await dbWrite.tag.update({
      where: { id },
      data: {
        tagsOnPosts: {
          connectOrCreate: {
            where: { tagId_postId: { tagId: id, postId } },
            create: { postId },
          },
        },
      },
    });
  }
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

  return await dbWrite.image.create({
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
};

export const updatePostImage = async (image: UpdatePostImageInput) => {
  const updateResources = image.resources.filter(isImageResource);
  const createResources = image.resources.filter(isNotImageResource);

  return await dbWrite.image.update({
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
};

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: { id: true } })
    )
  );

  return transaction;
};
