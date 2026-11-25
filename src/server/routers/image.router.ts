import { isSessionOrFullUserKey } from '~/server/auth/full-user-credential';
import { canSeeSongs } from '~/server/services/image-visibility.service';
import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import {
  deleteImageHandler,
  getImagesForModelVersionHandler,
  handleUpdateImageNsfwLevel,
  moderateImageHandler,
  setTosViolationHandler,
  removeSongCoverHandler,
  setVideoThumbnailController,
  updateImageAcceptableMinorHandler,
} from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { kyselyRead } from '~/server/db/kyselyDb';
import { getSongCoverForRemoval } from '~/server/services/song-cover-removal.service';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addImageTechniques,
  addImageTools,
  get404Images,
  getImageDetail,
  getImageGenerationData,
  getImagesByUserIdForModeration,
  getMyImages,
  getSongPlayCounts,
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
import { getSongGenreTagIds } from '~/server/services/song-genre.service';
import { getRisingSongIds } from '~/server/services/song-rising.service';
import { getSongLyrics } from '~/server/services/track-lyrics.service';
import { rescanImageById } from '~/server/services/image-rescan.service';
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
import { requestServableLevels } from '~/server/utils/browsing-level';
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
import { cacheIt, edgeCacheIt, noEdgeCacheWhen, rateLimit } from './../middleware.trpc';
import {
  IMAGE_404_CACHE_TAG,
  imageResourcesEdgeTag,
} from '~/server/services/image-visibility-invalidation.service';
import {
  addOrRemoveImageTechniquesSchema,
  addOrRemoveImageToolsSchema,
  getEntitiesCoverImage,
  getImageSchema,
  getInfiniteImagesSchema,
  getMyImagesInput,
  isViewerScopedImageFeed,
  isViewerScopedInfiniteFeed,
  imageModerationSchema,
  removeImageResourceSchema,
  reportCsamImagesSchema,
  getSongCoversSchema,
  setSongCoverSchema,
  setTosViolationSchema,
  setVideoThumbnailSchema,
  toggleImageFlagSchema,
  updateImageAcceptableMinorRateLimits,
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
    ownerId =
      (await dbRead.image.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? 0;
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
  /** "Remove cover" on a song: `id` is the song's; only its own cover is removed. */
  removeSongCover: moderatorProcedure.input(setTosViolationSchema).mutation(removeSongCoverHandler),
  /** The song's own cover, while there is one to remove, and whether it is held (refused). */
  getSongCoverRemoval: moderatorProcedure
    .input(getByIdSchema)
    .query(({ input }) => getSongCoverForRemoval(kyselyRead, input.id)),
  getApprovedAppeal: moderatorProcedure
    .input(getByIdSchema)
    .query(({ input }) => getApprovedImageAppeal(input.id)),
  getDetail: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getImageDetail({
        ...input,
        userId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
        ownerSeesHeld: isSessionOrFullUserKey(ctx),
        music: canSeeSongs(ctx.user ?? undefined),
      })
    ),
  /**
   * @ported-to-go feed-go · status: shadow · see ports/manifest.json (id: image.getInfinite).
   * Changing this behaviour? Update apps/feed-go/internal/server/server.go, apps/feed-go/internal/feed/infinite.go in the same PR; CI lists every port a PR touches.
   * Generated by `node scripts/ports/generate.mjs` from ports/manifest.json: edit the manifest, not this block.
   */
  getInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    .use(noEdgeCacheWhen(isViewerScopedInfiniteFeed))
    // One `user` object per creator on the wire (`image-feed-shared-users`, dark). Here rather
    // than in the handler, which `civitai-embed` also calls directly.
    .query(async (opts) => withSharedFeedUsers(await getInfiniteImagesHandler(opts))),
  getImagesForModelVersion: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getImagesForModelVersionHandler),
  /**
   * @ported-to-go feed-go · status: ramp · see ports/manifest.json (id: image.getImagesAsPostsInfinite).
   * Changing this behaviour? Update apps/feed-go/internal/server/server.go, apps/feed-go/internal/feed/posts.go in the same PR; CI lists every port a PR touches.
   * Generated by `node scripts/ports/generate.mjs` from ports/manifest.json: edit the manifest, not this block.
   */
  getImagesAsPostsInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    .use(noEdgeCacheWhen(isViewerScopedImageFeed))
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
        tags: (input: { id: number }) => [imageResourcesEdgeTag(input.id)],
      })
    )
    .query(getImageResourcesHandler),
  removeResource: moderatorProcedure
    .input(removeImageResourceSchema)
    .mutation(({ input }) => removeImageResource(input)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => rescanImageById(input)),
  getEntitiesCoverImage: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  get404Images: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    // invalidateImageVisibilityCaches purges both by tag. The key's version drops entries cached
    // before they carried the tag.
    .use(edgeCacheIt({ ttl: CacheTTL.day, tags: () => [IMAGE_404_CACHE_TAG] }))
    .use(
      cacheIt({
        key: 'image:get404Images:v4',
        ttl: CacheTTL.day,
        tags: () => [IMAGE_404_CACHE_TAG],
      })
    )
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
    // Chunks of 100 ids: one read per chunk plus one per player song.
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ input, ctx }) => getSongCoversForPlayer({ ...input, ctx })),
  // Per viewer (visibility and the music flag), so no edgeCacheIt.
  getSongPlays: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getSongCoversSchema)
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ input, ctx }) =>
      getSongPlayCounts({ ids: input.ids, features: ctx.features, user: ctx.user })
    ),
  // Per viewer (visibility and the music flag), so no edgeCacheIt.
  getRisingSongs: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ ctx }) => getRisingSongIds({ features: ctx.features, user: ctx.user })),
  // Per viewer (the music flag), so no `edgeCacheIt`.
  getSongGenreTags: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .query(({ ctx }) => getSongGenreTagIds(ctx)),
  // Per viewer (visibility and the music flag), so no `edgeCacheIt`.
  getSongLyrics: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ input, ctx }) => getSongLyrics({ id: input.id, ctx })),

  updateAccetableMinor: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageAcceptableMinorSchema)
    .use(rateLimit(updateImageAcceptableMinorRateLimits))
    .mutation(updateImageAcceptableMinorHandler),
  getMyImages: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getMyImagesInput)
    .query(({ input, ctx }) =>
      getMyImages({ ...input, userId: ctx.user.id, servableLevels: requestServableLevels(ctx) })
    ),
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
