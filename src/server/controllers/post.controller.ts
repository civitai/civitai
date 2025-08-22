import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import type { Context } from '~/server/createContext';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { eventEngine } from '~/server/events';
import { firstDailyPostReward, imagePostedToModelReward } from '~/server/rewards';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type { VideoMetadata } from '~/server/schema/media.schema';
import type {
  AddResourceToPostImageInput,
  PostCreateInput,
  RemoveResourceFromPostImageInput,
} from '~/server/schema/post.schema';
import {
  bulkSaveItems,
  getCollectionById,
  getUserCollectionPermissionsById,
  validateContestCollectionEntry,
} from '~/server/services/collection.service';
import { sendMessagesToCollaborators } from '~/server/services/entity-collaborator.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { updateVimeoVideo } from '~/server/vimeo/client';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { CollectionMode, CollectionType, EntityType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { dbRead, dbWrite } from '../db/client';
import type { GetByIdInput } from './../schema/base.schema';
import type {
  AddPostTagInput,
  GetPostTagsInput,
  PostsQueryInput,
  PostUpdateInput,
  RemovePostTagInput,
  ReorderPostImagesInput,
  UpdatePostCollectionTagIdInput,
  UpdatePostImageInput,
} from './../schema/post.schema';
import {
  addPostTag,
  addResourceToPostImage,
  createPost,
  deletePost,
  getPostContestCollectionDetails,
  getPostDetail,
  getPostResources,
  getPostsInfinite,
  getPostTags,
  removePostTag,
  removeResourceFromPostImage,
  reorderPostImages,
  updatePost,
  updatePostCollectionTagId,
  updatePostImage,
} from './../services/post.service';

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
    const { ip, fingerprint } = ctx;
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
        { postId: post.id, posterId: post.user.id },
        { ip, fingerprint }
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
  input: { collectionTagId, ...input },
  ctx,
}: {
  input: PostUpdateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const db = await getDbWithoutLag('post', input.id);
    const post = await db.post.findFirst({
      where: { id: input.id },
      select: {
        publishedAt: true,
        collectionId: true,
        id: true,
        nsfwLevel: true,
        title: true,
        detail: true,
      },
    });

    // Throw error if trying to reschedule a post that is already published
    const today = new Date();
    if (input.publishedAt && post?.publishedAt && dayjs(post.publishedAt).isBefore(today)) {
      throw throwBadRequestError('You cannot reschedule a post that is already published');
    }

    if (
      input.publishedAt &&
      !post?.publishedAt &&
      post?.collectionId &&
      dayjs(input.publishedAt).isAfter(dayjs().add(10, 'minutes'))
    ) {
      // Force be published right away.
      input.publishedAt = new Date();
    }

    if (post && input.publishedAt && input.collectionId) {
      // Confirm & Validate in the case of a contest collection
      // That a submission can be made. We only do this as the user publishes
      // Because images are ready only at this point.

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
        input: { id: input.collectionId },
      });

      if (collection.type !== CollectionType.Post && collection.type !== CollectionType.Image) {
        throw throwBadRequestError(
          'The collection you are trying to select is not a post or image collection'
        );
      }

      if (
        collection.tags.length > 0 &&
        !collectionTagId &&
        !collection.metadata?.disableTagRequired
      ) {
        throw throwBadRequestError('You must select an entry category for this collection');
      }

      if (collection.metadata.entriesRequireTitle && !post.title) {
        throw throwBadRequestError('Your entry must have a title to be submitted');
      }

      if (collection.metadata.entriesRequireTools) {
        // Check all images within this post has tools:
        const exists = await dbRead.image.findFirst({
          where: {
            postId: input.id,
            tools: { none: {} },
          },
        });

        if (exists) throw throwBadRequestError('All images must have tools to be submitted');
      }

      if (collection.mode === CollectionMode.Contest) {
        const postIds = collection.type === CollectionType.Post ? [input.id] : [];
        const images =
          collection.type === CollectionType.Image
            ? await dbWrite.image.findMany({
                where: { postId: post.id },
                select: { id: true },
              })
            : [];

        await validateContestCollectionEntry({
          metadata: collection.metadata as CollectionMetadataSchema,
          collectionId: collection.id,
          userId: ctx.user.id,
          isModerator: ctx.user.isModerator,
          postIds,
          imageIds: images.map((i) => i.id),
        });
      }
    }

    const updatedPost = await updatePost({ ...input, user: ctx.user });
    const collection = updatedPost.collectionId
      ? await getCollectionById({
          input: { id: updatedPost.collectionId },
        })
      : undefined;

    const wasPublished = !post?.publishedAt && updatedPost.publishedAt;
    if (wasPublished) {
      const postTags = await db.postTag.findMany({
        where: { postId: updatedPost.id },
        select: { tagName: true },
      });

      const isScheduled = dayjs(updatedPost.publishedAt).isAfter(dayjs().add(10, 'minutes')); // Publishing more than 10 minutes in the future
      const tags = postTags.map((x) => x.tagName);

      if (!isScheduled) {
        await sendMessagesToCollaborators({
          entityId: updatedPost.id,
          entityType: EntityType.Post,
          userId: ctx.user.id,
        });
      }

      // Technically, collectionPosts cannot be scheduled.
      if (!!updatedPost?.collectionId && collection) {
        // Create the relevant collectionItem:
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
              tagId: collectionTagId,
              isModerator: ctx.user.isModerator,
            },
            permissions,
          });
        } else if (collection.type === CollectionType.Image) {
          // get all images with this postId. We're using DB write in case there's some lag.
          const images = await dbWrite.image.findMany({
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

          const resp = await bulkSaveItems({
            input: {
              collectionId: updatedPost.collectionId,
              imageIds: images.map((i) => i.id),
              userId: ctx.user.id,
              tagId: collectionTagId,
            },
            permissions,
          });

          for (const imgId of resp.imageIds) {
            await updateEntityMetric({
              ctx,
              entityType: 'Image',
              entityId: imgId,
              metricType: 'Collection',
              amount: 1,
            });
          }
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
          { ip: ctx.ip, fingerprint: ctx.fingerprint }
        );
      }

      // Give reward for first post of the day
      await firstDailyPostReward.apply(
        {
          postId: updatedPost.id,
          posterId: updatedPost.userId,
        },
        { ip: ctx.ip, fingerprint: ctx.fingerprint }
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

    if (
      post?.collectionId &&
      collection?.metadata?.vimeoSupportEnabled &&
      (post.title !== updatedPost.title || post.detail !== updatedPost.detail) &&
      // We need title for Vimeo. This is required.
      !!updatedPost.title &&
      // We need the access token to update the video.
      env.VIMEO_ACCESS_TOKEN
    ) {
      // UPDATE VIMEO ITEMS IF EXISTS:
      const images = await dbWrite.image.findMany({
        where: {
          postId: updatedPost.id,
        },
        select: {
          id: true,
          metadata: true,
        },
      });

      const vimeoVideoIds = images
        .map((i) => (i.metadata as VideoMetadata).vimeoVideoId)
        .filter(isDefined);

      if (vimeoVideoIds.length) {
        await Promise.all(
          vimeoVideoIds.map(async (vimeoVideoId) => {
            try {
              await updateVimeoVideo({
                videoId: vimeoVideoId,
                title: updatedPost.title as string,
                description: updatedPost.detail,
                accessToken: env.VIMEO_ACCESS_TOKEN as string,
              });
            } catch (error) {
              // Do nothing atm. We just ignore the error.
            }
          })
        );
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

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: post.user.id });
      if (blocked) throw throwNotFoundError();
    }

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

export const addResourceToPostImageHandler = async ({
  input,
  ctx,
}: {
  input: AddResourceToPostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await addResourceToPostImage({ ...input, user: ctx.user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const removeResourceFromPostImageHandler = async ({
  input,
  ctx,
}: {
  input: RemoveResourceFromPostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await removeResourceFromPostImage({ ...input, user: ctx.user });
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

// #region [post for collections]
export const getPostContestCollectionDetailsHandler = async ({
  input,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const items = await getPostContestCollectionDetails({ ...input });
    return items;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updatePostCollectionTagIdHandler = async ({
  input,
}: {
  input: UpdatePostCollectionTagIdInput;
}) => {
  try {
    return updatePostCollectionTagId({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion
