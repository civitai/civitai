import { GetByIdInput } from './../schema/base.schema';
import {
  PostUpdateInput,
  AddPostImageInput,
  ReorderPostImagesInput,
  AddPostTagInput,
  RemovePostTagInput,
  UpdatePostImageInput,
  GetPostTagsInput,
  PostsQueryInput,
} from './../schema/post.schema';
import {
  createPost,
  getPostDetail,
  updatePost,
  addPostImage,
  reorderPostImages,
  deletePost,
  addPostTag,
  removePostTag,
  getPostEditDetail,
  updatePostImage,
  getPostTags,
  getPostsInfinite,
  getPostResources,
} from './../services/post.service';
import { TRPCError } from '@trpc/server';
import { PostCreateInput } from '~/server/schema/post.schema';
import {
  throwDbError,
  throwNotFoundError,
  throwAuthorizationError,
  throwBadRequestError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '../db/client';
import { firstDailyPostReward, imagePostedToModelReward } from '~/server/rewards';
import { eventEngine } from '~/server/events';
import dayjs from 'dayjs';
import { hasEntityAccess } from '../services/common.service';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  CollectionMetadataSchema,
  getCollectionPermissionDetails,
} from '~/server/schema/collection.schema';
import {
  bulkSaveItems,
  getCollectionById,
  getUserCollectionPermissionsById,
  validateContestCollectionEntry,
} from '~/server/services/collection.service';
import { CollectionMode, CollectionType } from '@prisma/client';

export const getPostsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: PostsQueryInput;
  ctx: Context;
}) => {
  try {
    return await getPostsInfinite({ ...input, user: ctx.user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const createPostHandler = async ({
  input,
  ctx,
}: {
  input: PostCreateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const post = await createPost({ userId: ctx.user.id, ...input });
    const isPublished = !!post.publishedAt;
    const isScheduled = isPublished && dayjs(post.publishedAt).isAfter(dayjs().add(10, 'minutes')); // Publishing more than 10 minutes in the future
    const tags = post.tags.map((x) => x.name);
    if (isScheduled) tags.push('scheduled');

    await ctx.track.post({
      type: 'Create',
      nsfw: !getIsSafeBrowsingLevel(post.nsfwLevel),
      postId: post.id,
      tags,
    });

    if (isPublished && !isScheduled) {
      await firstDailyPostReward.apply(
        {
          postId: post.id,
          posterId: post.user.id,
        },
        ctx.ip
      );

      await ctx.track.post({
        type: 'Publish',
        nsfw: !getIsSafeBrowsingLevel(post.nsfwLevel),
        postId: post.id,
        tags,
      });
      await eventEngine.processEngagement({
        userId: post.user.id,
        type: 'published',
        entityType: 'post',
        entityId: post.id,
      });
    }

    return post;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updatePostHandler = async ({
  input,
  ctx,
}: {
  input: PostUpdateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.collectionId) {
      // Check if user has access to the collection
      const permissions = await getUserCollectionPermissionsById({
        id: input.collectionId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });

      if (!permissions.write && !permissions.writeReview) {
        throw throwAuthorizationError('You cannot post to this collection');
      }

      const collection = await getCollectionById({
        input: {
          id: input.collectionId,
        },
      });

      if (collection.type !== CollectionType.Post && collection.type !== CollectionType.Image) {
        throw throwBadRequestError(
          'The collection you are trying to select is not a post or image collection'
        );
      }
    }

    const post = await dbRead.post.findFirst({
      where: {
        id: input.id,
      },
      select: {
        publishedAt: true,
        collectionId: true,
        id: true,
      },
    });

    if (
      input.publishedAt &&
      !post?.publishedAt &&
      post?.collectionId &&
      dayjs(input.publishedAt).isAfter(dayjs().add(10, 'minutes'))
    ) {
      throw throwBadRequestError('Cannot schedule a post in a collection');
    }

    if (input.publishedAt && post?.collectionId) {
      // Confirm & Validate in the case of a contest collection
      // That a submission can be made. We only do this as the user publishes
      // Because images are ready only at this point.
      const collection = await getCollectionById({
        input: {
          id: post.collectionId,
        },
      });

      if (collection.mode === CollectionMode.Contest) {
        const postIds = collection.type === CollectionType.Post ? [input.id] : [];
        const images =
          collection.type === CollectionType.Image
            ? await dbRead.image.findMany({
                where: {
                  postId: post.id,
                },
                select: {
                  id: true,
                },
              })
            : [];
        await validateContestCollectionEntry({
          metadata: collection.metadata as CollectionMetadataSchema,
          collectionId: collection.id,
          userId: ctx.user.id,
          postIds,
          imageIds: images.map((i) => i.id),
        });
      }
    }

    const updatedPost = await updatePost({
      ...input,
      user: ctx.user,
    });

    const wasPublished = !post?.publishedAt && updatedPost.publishedAt;
    if (wasPublished) {
      const postTags = await dbRead.postTag.findMany({
        where: {
          postId: updatedPost.id,
        },
        select: {
          tagName: true,
        },
      });

      const isScheduled = dayjs(updatedPost.publishedAt).isAfter(dayjs().add(10, 'minutes')); // Publishing more than 10 minutes in the future
      const tags = postTags.map((x) => x.tagName);

      // Technically, collectionPosts cannot be scheduled.
      if (!!updatedPost?.collectionId && !isScheduled) {
        // Create the relevant collectionItem:
        const collection = await getCollectionById({
          input: {
            id: updatedPost.collectionId,
          },
        });

        const permissions = await getUserCollectionPermissionsById({
          id: updatedPost.collectionId,
          userId: ctx.user.id,
          isModerator: ctx.user.isModerator,
        });

        if (collection.type === CollectionType.Post) {
          await bulkSaveItems({
            input: {
              collectionId: updatedPost.collectionId,
              postIds: [updatedPost.id],
              userId: ctx.user.id,
            },
            permissions,
          });
        } else if (collection.type === CollectionType.Image) {
          // get all images with this postId:
          const images = await dbRead.image.findMany({
            where: {
              postId: updatedPost.id,
            },
            select: {
              id: true,
            },
          });

          if (!images.length) {
            throw throwBadRequestError('No images found for this post');
          }

          await bulkSaveItems({
            input: {
              collectionId: updatedPost.collectionId,
              imageIds: images.map((i) => i.id),
              userId: ctx.user.id,
            },
            permissions,
          });
        }
      }

      if (isScheduled) tags.push('scheduled');
      await ctx.track.post({
        type: 'Publish',
        nsfw: !getIsSafeBrowsingLevel(updatedPost.nsfwLevel),
        postId: updatedPost.id,
        tags,
      });

      // Give reward to owner of modelVersion
      if (updatedPost.modelVersionId) {
        const modelVersion = await dbRead.modelVersion.findUnique({
          where: { id: updatedPost.modelVersionId },
        });

        await imagePostedToModelReward.apply(
          {
            modelId: modelVersion?.modelId,
            modelVersionId: updatedPost.modelVersionId,
            posterId: updatedPost.userId,
          },
          ctx.ip
        );
      }

      // Give reward for first post of the day
      await firstDailyPostReward.apply(
        {
          postId: updatedPost.id,
          posterId: updatedPost.userId,
        },
        ctx.ip
      );

      if (!isScheduled) {
        await eventEngine.processEngagement({
          userId: updatedPost.userId,
          type: 'published',
          entityType: 'post',
          entityId: updatedPost.id,
        });
      }
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getPostHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const post = await getPostDetail({ ...input, user: ctx.user });
    if (!post) throw throwNotFoundError();

    return post;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// export type PostEditDetail = AsyncReturnType<typeof getPostEditHandler>;
// export type PostEditImage = PostEditDetail['images'][0] & { previewUrl?: string };
// export const getPostEditHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
//   try {
//     const post = await getPostEditDetail(input);
//     if (!post) throw throwNotFoundError();
//     const isOwnerOrModerator = post.userId === ctx.user?.id || ctx.user?.isModerator;
//     if (!isOwnerOrModerator) throw throwAuthorizationError();
//     return post;
//   } catch (error) {
//     if (error instanceof TRPCError) throw error;
//     else throw throwDbError(error);
//   }
// };

export const deletePostHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const result = await deletePost({ ...input });
    if (result) {
      await ctx.track.post({
        type: 'Delete',
        nsfw: !getIsSafeBrowsingLevel(result.nsfwLevel),
        postId: result.id,
        tags: [],
      });
    }

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// #region [post images]
export const addPostImageHandler = async ({
  input,
  ctx,
}: {
  input: AddPostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await addPostImage({ ...input, user: ctx.user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updatePostImageHandler = async ({
  input,
}: {
  input: UpdatePostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await updatePostImage({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const reorderPostImagesHandler = async ({
  input,
}: {
  input: ReorderPostImagesInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await reorderPostImages({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion

// #region [post tags]
export const getPostTagsHandler = async ({ input }: { input: GetPostTagsInput }) => {
  try {
    return await getPostTags({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const addPostTagHandler = async ({
  input,
  ctx,
}: {
  input: AddPostTagInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const result = await addPostTag({ ...input });
    const post = await dbRead.post.findFirstOrThrow({
      where: {
        id: input.id,
      },
      select: {
        nsfw: true,
        tags: {
          select: {
            tag: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
    await ctx.track.post({
      type: 'Tags',
      postId: input.id,
      nsfw: post.nsfw,
      tags: post.tags.map((x) => x.tag.name),
    });
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const removePostTagHandler = async ({
  input,
  ctx,
}: {
  input: RemovePostTagInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await removePostTag({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion

// #region [post resources]
export const getPostResourcesHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const resources = await getPostResources({ ...input });

    return resources.filter((x) => x.name !== 'vae');
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion
