import { imageSelect } from './../selectors/image.selector';
import { userWithCosmeticsSelect } from './../selectors/user.selector';
import { GetByIdInput } from './../schema/base.schema';
import {
  PostUpdateInput,
  AddPostTagSchema,
  AddPostImageInput,
  PostCreateInput,
} from './../schema/post.schema';
import { dbWrite } from '~/server/db/client';
import { TagType, TagTarget, Prisma } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';

/** used for post detail and create services */
const postImageSelect = imageSelect;

export const createPost = async ({
  userId,
  modelVersionId,
}: PostCreateInput & { userId: number }) => {
  return await dbWrite.post.create({ data: { userId, modelVersionId } });
};

export const updatePost = async (data: PostUpdateInput) => {
  await dbWrite.post.update({ where: { id: data.id }, data });
};

export const updatePostTags = async ({ postId, id, name: initialName }: AddPostTagSchema) => {
  const name = initialName.toLowerCase();
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

export const getPost = async ({ id }: GetByIdInput) => {
  return await dbWrite.post.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      scanned: true,
      user: { select: userWithCosmeticsSelect },
      images: { select: postImageSelect },
    },
  });
};

export const addPostImage = async ({
  resources,
  ...image
}: AddPostImageInput & { userId: number }) => {
  const autoResources = !!resources?.length
    ? await dbWrite?.modelHash.findMany({
        where: { hash: { in: resources, mode: 'insensitive' } },
        select: {
          file: {
            select: {
              modelVersionId: true,
            },
          },
        },
      })
    : [];

  return await dbWrite.image.create({
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: image.meta
        ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
        : null,
      resources: !!autoResources.length
        ? {
            create: autoResources.map((item) => ({
              modelVersionId: item.file.modelVersionId,
              detected: true,
            })),
          }
        : undefined,
    },
    select: postImageSelect,
  });
};
