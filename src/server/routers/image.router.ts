import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import {
  deleteImageHandler,
  getImagesForModelVersionHandler,
  handleUpdateImageNsfwLevel,
  moderateImageHandler,
  setTosViolationHandler,
  setVideoThumbnailController,
  updateImageAcceptableMinorHandler,
} from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addImageTechniques,
  addImageTools,
  get404Images,
  getImageDetail,
  getImageGenerationData,
  getImagesByUserIdForModeration,
  getMyImages,
  ingestImageById,
  removeImageResource,
  removeImageTechniques,
  removeImageTools,
  reportCsamImages,
  toggleImageFlag,
  updateImageTechniques,
  updateImageTools,
  refreshImageResources,
} from '~/server/services/image.service';
import { getSongCoversForPlayer, setSongCover } from '~/server/services/post.service';
import { getSongLyrics } from '~/server/services/track-lyrics.service';
import {
  middleware,
  guardedProcedure,
  heavyProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { getApprovedImageAppeal } from '~/server/services/image-removal-hold.service';
import { canAppealOwnImage } from '~/server/services/report.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  getEntitiesCoverImageHandler,
  getImageContestCollectionDetailsHandler,
  getImageHandler,
  getImagePublishedWithAppHandler,
  getImageResourcesHandler,
  getImagesAsPostsInfiniteHandler,
  getInfiniteImagesHandler,
} from './../controllers/image.controller';
import { withSharedFeedUsers } from '~/server/utils/feed-shared-users';
import { cacheIt, edgeCacheIt, rateLimit } from './../middleware.trpc';
import {
  addOrRemoveImageTechniquesSchema,
  addOrRemoveImageToolsSchema,
  getEntitiesCoverImage,
  getImageSchema,
  getInfiniteImagesSchema,
  getMyImagesInput,
  imageModerationSchema,
  removeImageResourceSchema,
  reportCsamImagesSchema,
  getSongCoversSchema,
  setSongCoverSchema,
  setTosViolationSchema,
  setVideoThumbnailSchema,
  toggleImageFlagSchema,
  updateImageAcceptableMinorSchema,
  updateImageNsfwLevelSchema,
  updateImageTechniqueSchema,
  updateImageToolsSchema,
} from './../schema/image.schema';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.image.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
      ownerId,
    },
  });
});

// TODO.cleanup - remove unused router methods
export const imageRouter = router({
  moderate: moderatorProcedure.input(imageModerationSchema).mutation(moderateImageHandler),
  delete: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteImageHandler),
  setTosViolation: moderatorProcedure.input(setTosViolationSchema).mutation(setTosViolationHandler),
  getApprovedAppeal: moderatorProcedure
    .input(getByIdSchema)
    .query(({ input }) => getApprovedImageAppeal(input.id)),
  getDetail: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getImageDetail({ ...input, userId: ctx.user?.id, isModerator: ctx.user?.isModerator })
    ),
  getInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    // One `user` object per creator on the wire (`image-feed-shared-users`, dark). Here rather
    // than in the handler, which `civitai-embed` also calls directly.
    .query(async (opts) => withSharedFeedUsers(await getInfiniteImagesHandler(opts))),
  getImagesForModelVersion: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getImagesForModelVersionHandler),
  getImagesAsPostsInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    .query(getImagesAsPostsInfiniteHandler),
  get: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getImageSchema)
    .query(getImageHandler),
  // The image page's "Published with <app>" credit. Per viewer (store-scope gated), so
  // deliberately NO `edgeCacheIt` — see `getImagePublishedWithAppHandler`.
  getPublishedWithApp: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getImagePublishedWithAppHandler),
  getResources: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.sm,
      })
    )
    .query(getImageResourcesHandler),
  removeResource: moderatorProcedure
    .input(removeImageResourceSchema)
    .mutation(({ input }) => removeImageResource(input)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => ingestImageById(input)),
  getEntitiesCoverImage: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  get404Images: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(edgeCacheIt({ ttl: CacheTTL.month }))
    .use(cacheIt({ ttl: CacheTTL.week }))
    .query(() => get404Images()),
  reportCsamImages: moderatorProcedure
    .input(reportCsamImagesSchema)
    .mutation(({ input, ctx }) => reportCsamImages({ ...input, user: ctx.user, ip: ctx.ip })),
  updateImageNsfwLevel: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(updateImageNsfwLevelSchema)
    .mutation(handleUpdateImageNsfwLevel),
  getGenerationData: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    // TODO: Add edgeCacheIt back after fixing the cache invalidation.
    // .use(
    //   edgeCacheIt({
    //     ttl: CacheTTL.day, // Cache is purged on remove resource
    //     tags: (i) => ['image-generation-data', `image-generation-data-${i.id}`],
    //   })
    // )
    .query(({ input, ctx }) => getImageGenerationData({ id: input.id, viewer: ctx })),

  // #region [tools]
  addTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => addImageTools({ ...input, user: ctx.user })),
  removeTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => removeImageTools({ ...input, user: ctx.user })),
  updateTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageToolsSchema)
    .mutation(({ input, ctx }) => updateImageTools({ ...input, user: ctx.user })),
  // #endregion

  // #region [techniques]
  addTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => addImageTechniques({ ...input, user: ctx.user })),
  removeTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => removeImageTechniques({ ...input, user: ctx.user })),
  updateTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageTechniqueSchema)
    .mutation(({ input, ctx }) => updateImageTechniques({ ...input, user: ctx.user })),
  // #endregion

  // #region [collections]
  getContestCollectionDetails: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getImageContestCollectionDetailsHandler),
  // #endregion

  // #region [moderation]
  getImagesByUserIdForModeration: moderatorProcedure
    .input(
      z.object({
        userId: z.number(),
        captureImageIds: z.number().int().array().max(500).optional(),
      })
    )
    .query(({ input }) => getImagesByUserIdForModeration(input.userId, input.captureImageIds)),

  // #endregion

  // #region [thumbnail]
  setThumbnail: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(setVideoThumbnailSchema)
    .mutation(setVideoThumbnailController),
  // #endregion

  setSongCover: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(setSongCoverSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input, ctx }) => setSongCover({ ...input, user: ctx.user })),
  // Per viewer (visibility, domain level and the music flag), so no `edgeCacheIt`.
  getSongCovers: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getSongCoversSchema)
    // A page reads once for its song tiles and once per song the player shows; clients keep each
    // answer for 5 minutes.
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ input, ctx }) => getSongCoversForPlayer({ ...input, ctx })),
  // Per viewer (visibility and the music flag), so no `edgeCacheIt`.
  getSongLyrics: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getSongLyrics({ id: input.id, ctx })),

  updateAccetableMinor: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageAcceptableMinorSchema)
    .mutation(updateImageAcceptableMinorHandler),
  getMyImages: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getMyImagesInput)
    .query(({ input, ctx }) => getMyImages({ ...input, userId: ctx.user.id })),
  getAppealState: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(async ({ input, ctx }) => ({
      canAppeal: await canAppealOwnImage({ imageId: input.id, userId: ctx.user.id }),
    })),
  toggleImageFlag: moderatorProcedure
    .input(toggleImageFlagSchema)
    .mutation(({ input, ctx }) => toggleImageFlag({ ...input })),
  refreshImageResources: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => refreshImageResources(input.id)),
});
