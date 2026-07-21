import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { increaseDate } from '~/utils/date-helpers';
import { env } from '~/env/server';
import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';
import type { Context, ProtectedContext } from '~/server/createContext';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { eventEngine } from '~/server/events';
import { firstDailyPostReward, imagePostedToModelReward } from '~/server/rewards';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type { VideoMetadata } from '~/server/schema/media.schema';
import type {
  AddResourceToPostImageInput,
  CreatePostWithImagesInput,
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
import { publishModel3D } from '~/server/services/model3d.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  handleLogError,
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
import { dbReadFallbackCounter } from '~/server/prom/client';
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
  addPostImage,
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
  ctx: ProtectedContext;
}) => {
  try {
    const { ip } = ctx;
    const today = new Date();

    const post = await createPost({ userId: ctx.user.id, ...input });
    const isPublished = !!post.publishedAt;
    const minimumScheduleTime = increaseDate(today, POST_MINIMUM_SCHEDULE_MINUTES, 'minutes');
    const isScheduled = isPublished && dayjs(post.publishedAt).isAfter(minimumScheduleTime); // Publishing more than minimum schedule time in the future
    const tags = post.tags.map((x) => x.name);
    if (isScheduled) tags.push('scheduled');

    await ctx.track.post({
      type: 'Create',
      nsfw: !getIsSafeBrowsingLevel(post.nsfwLevel),
      postId: post.id,
      tags,
    });

    if (isPublished && !isScheduled) {
      await firstDailyPostReward.apply({ postId: post.id, posterId: post.user.id }, { ip });

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

/**
 * Composite create-with-images handler for headless/agent (MCP) use.
 *
 * Creates the post, attaches each image in order, and optionally publishes —
 * all server-side — to eliminate the multi-round-trip + orphan-draft window the
 * MCP previously handled client-side. Reuses the existing createPost / addPostImage
 * services and the full updatePostHandler publish path (rewards, tracking,
 * collection items, contest validation) for the publish step.
 *
 * No single DB transaction is feasible here: createPost, addPostImage (which
 * triggers image ingestion + cache busting), and the publish path each manage
 * their own writes/side-effects. Instead we do best-effort sequential work and,
 * on any failure before returning, DELETE the created post so no orphan draft
 * remains.
 */
export const createPostWithImagesHandler = async ({
  input,
  ctx,
}: {
  input: CreatePostWithImagesInput;
  ctx: ProtectedContext;
}) => {
  const { images, publish, collectionId, ...createInput } = input;

  // 1) Create the draft post (reuses createPostHandler for tracking + rewards
  //    on the no-image publish path; we publish separately below once images
  //    exist, so we always create as a draft here).
  const post = await createPostHandler({
    input: { ...createInput, collectionId },
    ctx,
  });

  try {
    // 2) Attach each image in order.
    const sortedImages = [...images].sort((a, b) => a.index - b.index);
    const attachedImageIds: number[] = [];
    for (const image of sortedImages) {
      const attached = await addPostImage({ ...image, postId: post.id, user: ctx.user });
      attachedImageIds.push(attached.id);
    }

    // 3) Optionally publish. Route through updatePostHandler so the full publish
    //    path runs (rewards, tracking, collaborator messages, collection items,
    //    contest validation). updatePostHandler returns void.
    if (publish) {
      await updatePostHandler({
        input: { id: post.id, publishedAt: new Date(), collectionId },
        ctx,
      });
    }

    // Re-select the post's current persisted state so the response reflects
    // mutations that happen after the initial create: nsfwLevel is recomputed
    // once images are attached, and publish can adjust collectionId/publishedAt.
    // Returning the stale create-time `post` object would be inconsistent w/ DB.
    const current = await dbWrite.post.findUnique({
      where: { id: post.id },
      select: {
        title: true,
        detail: true,
        modelVersionId: true,
        collectionId: true,
        publishedAt: true,
        nsfwLevel: true,
      },
    });

    return {
      id: post.id,
      title: current?.title ?? post.title,
      detail: current?.detail ?? post.detail,
      modelVersionId: current?.modelVersionId ?? post.modelVersionId,
      collectionId: current?.collectionId ?? post.collectionId,
      publishedAt: current?.publishedAt ?? null,
      imageIds: attachedImageIds,
      nsfwLevel: current?.nsfwLevel ?? post.nsfwLevel,
    };
  } catch (error) {
    // Roll back the orphan draft so no empty/partial post lingers.
    await deletePost({ id: post.id, isModerator: ctx.user.isModerator }).catch(handleLogError);
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const updatePostHandler = async ({
  input: { collectionTagId, ...input },
  ctx,
}: {
  input: PostUpdateInput;
  ctx: ProtectedContext;
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

    const minimumScheduleTime = increaseDate(today, POST_MINIMUM_SCHEDULE_MINUTES, 'minutes');

    // Handle publishedAt adjustment: if the client-sent date is in the past or
    // before the minimum schedule time, publish immediately. This tolerates
    // client clock drift and network latency on normal "Publish" clicks. The
    // check above already blocks modifying an already-published post's date.
    if (input.publishedAt && dayjs(input.publishedAt).isBefore(minimumScheduleTime)) {
      input.publishedAt = today;
    }

    if (
      input.publishedAt &&
      !post?.publishedAt &&
      post?.collectionId &&
      dayjs(input.publishedAt).isAfter(minimumScheduleTime)
    ) {
      // Force be published right away.
      input.publishedAt = today;
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
          canAccessUserChallenges: ctx.features.userChallenges,
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

      const minimumScheduleTimeForPublish = increaseDate(
        new Date(),
        POST_MINIMUM_SCHEDULE_MINUTES,
        'minutes'
      );
      const isScheduled = dayjs(updatedPost.publishedAt).isAfter(minimumScheduleTimeForPublish); // Publishing more than minimum schedule time in the future
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
              canAccessUserChallenges: ctx.features.userChallenges,
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
              canAccessUserChallenges: ctx.features.userChallenges,
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
          { ip: ctx.ip }
        );
      }

      // If the post is linked to a Model3D draft (queue-card "Post from
      // Generation" flow), flip that draft to Published in lockstep. We
      // swallow errors so a model3d-side hiccup doesn't block the post
      // publish — publishModel3D is idempotent and we'll surface failures
      // separately if it becomes a real problem.
      if (updatedPost.model3dId) {
        try {
          await publishModel3D({
            input: { id: updatedPost.model3dId },
            user: ctx.user,
          });
        } catch (error) {
          // Non-fatal: log via the standard tRPC error path but don't throw.
          // The post is already published; the user can retry from the
          // Model3D detail page if the draft is stuck.
          // eslint-disable-next-line no-console
          console.error('Failed to publish linked Model3D', {
            postId: updatedPost.id,
            model3dId: updatedPost.model3dId,
            error,
          });
        }
      }

      // Give reward for first post of the day
      await firstDailyPostReward.apply(
        {
          postId: updatedPost.id,
          posterId: updatedPost.userId,
        },
        { ip: ctx.ip }
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  try {
    const result = await addPostTag({ ...input });
    const postFindArgs = {
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
    } as const;
    const post = await dbRead.post.findFirstOrThrow(postFindArgs).catch(() => {
      dbReadFallbackCounter.inc({ entity: 'post', caller: 'addPostTagHandler' });
      return dbWrite.post.findFirstOrThrow(postFindArgs);
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
  ctx: ProtectedContext;
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
