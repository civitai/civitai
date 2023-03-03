import { throwNotFoundError } from '~/server/utils/errorHandling';
import { GetByIdInput } from './../schema/base.schema';
import {
  PostUpdateInput,
  AddPostTagInput,
  AddPostImageInput,
  PostCreateInput,
  ReorderPostImagesInput,
  RemovePostTagInput,
} from './../schema/post.schema';
import { dbWrite } from '~/server/db/client';
import { TagType, TagTarget, Prisma } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { postImageSelect, postSelect } from '~/server/selectors/post.selector';
import { ModelFileType } from '~/server/common/constants';

export const getPost = async ({ id }: GetByIdInput) => {
  const post = await dbWrite.post.findUnique({
    where: { id },
    select: postSelect,
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
  return await dbWrite.post.create({ data: { userId, modelVersionId }, select: postSelect });
};

export const updatePost = async (data: PostUpdateInput) => {
  await dbWrite.post.update({ where: { id: data.id }, data });
};

export const deletePost = async ({ id }: GetByIdInput) => {
  await dbWrite.post.delete({ where: { id } });
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
  const uniqueResources = [...new Set(autoResources)];
  return await dbWrite.image.create({
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: image.meta
        ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
        : null,
      resources: !!uniqueResources.length
        ? {
            create: uniqueResources.map((item) => ({
              modelVersionId: item.modelVersionId,
              detected: true,
            })),
          }
        : undefined,
    },
    select: postImageSelect,
  });
};

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: postImageSelect })
    )
  );

  return transaction;
};
