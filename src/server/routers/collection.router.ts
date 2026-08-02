import {
  addSimpleImagePostHandler,
  bulkSaveItemsHandler,
  collectionItemsInfiniteHandler,
  deleteUserCollectionHandler,
  enableCollectionYoutubeSupportHandler,
  followHandler,
  getAllCollectionsInfiniteHandler,
  getAllUserCollectionsHandler,
  getCollectionByIdHandler,
  getPermissionDetailsHandler,
  getUserCollectionItemsByItemHandler,
  joinCollectionAsManagerHandler,
  removeCollectionItemHandler,
  saveItemHandler,
  setCollectionItemNsfwLevelHandler,
  setItemScoreHandler,
  unfollowHandler,
  updateCollectionCoverImageHandler,
  updateCollectionItemsStatusHandler,
  upsertCollectionHandler,
} from '~/server/controllers/collection.controller';
import { dbRead } from '~/server/db/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addSimpleImagePostInput,
  bulkSaveCollectionItemsInput,
  enableCollectionYoutubeSupportInput,
  followCollectionInputSchema,
  getAllCollectionItemsSchema,
  getAllCollectionsInfiniteSchema,
  getAllUserCollectionsInputSchema,
  getCollectionPermissionDetails,
  getUserCollectionItemsByItemSchema,
  removeCollectionItemInput,
  saveCollectionItemInputSchema,
  setCollectionItemNsfwLevelInput,
  setItemScoreInput,
  updateCollectionCoverImageInput,
  updateCollectionItemsStatusInput,
  upsertCollectionInput,
  setCollectionAiReviewInput,
} from '~/server/schema/collection.schema';
import {
  getCollectionEntryCount,
  setCollectionAiReview,
} from '~/server/services/collection.service';
import {
  guardedProcedure,
  isFlagProtected,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { getYoutubeAuthUrl } from '~/server/youtube/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.collection.findUnique({ where: { id } }))?.userId ?? 0;
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

export const collectionRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getAllCollectionsInfiniteSchema)
    .use(isFlagProtected('profileCollections'))
    .query(getAllCollectionsInfiniteHandler),
  getAllUser: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('collections'))
    .query(getAllUserCollectionsHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .query(getCollectionByIdHandler),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(upsertCollectionInput)
    .use(isOwnerOrModerator)
    .mutation(upsertCollectionHandler),
  updateCoverImage: guardedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(updateCollectionCoverImageInput)
    .mutation(updateCollectionCoverImageHandler),
  saveItem: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(saveCollectionItemInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(saveItemHandler),
  follow: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(followCollectionInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(followHandler),
  unfollow: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(followCollectionInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(unfollowHandler),
  getUserCollectionItemsByItem: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getUserCollectionItemsByItemSchema)
    .use(isFlagProtected('collections'))
    .query(getUserCollectionItemsByItemHandler),
  getAllCollectionItems: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getAllCollectionItemsSchema)
    .use(isFlagProtected('collections'))
    .query(collectionItemsInfiniteHandler),
  updateCollectionItemsStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(updateCollectionItemsStatusInput)
    .use(isFlagProtected('collections'))
    .mutation(updateCollectionItemsStatusHandler),
  // Moderator-only rather than collection MANAGE: the prompt becomes an LLM system prompt, and
  // reviews cost us money. isFlagProtected gates the endpoint itself, not just the UI.
  setAiReview: moderatorProcedure
    .input(setCollectionAiReviewInput)
    .use(isFlagProtected('collectionAiReview'))
    .mutation(({ input }) => setCollectionAiReview(input)),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .use(isOwnerOrModerator)
    .mutation(deleteUserCollectionHandler),
  bulkSaveItems: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(bulkSaveCollectionItemsInput)
    .use(isFlagProtected('collections'))
    .mutation(bulkSaveItemsHandler),
  addSimpleImagePost: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(addSimpleImagePostInput)
    .use(isFlagProtected('collections'))
    .mutation(addSimpleImagePostHandler),
  getPermissionDetails: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getCollectionPermissionDetails)
    .use(isFlagProtected('collections'))
    .query(getPermissionDetailsHandler),
  removeFromCollection: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(removeCollectionItemInput)
    .use(isFlagProtected('collections'))
    .mutation(removeCollectionItemHandler),
  setItemScore: guardedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(setItemScoreInput)
    .use(isFlagProtected('collections'))
    .mutation(setItemScoreHandler),
  updateCollectionItemNSFWLevel: guardedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(setCollectionItemNsfwLevelInput)
    .use(isFlagProtected('collections'))
    .mutation(setCollectionItemNsfwLevelHandler),
  getYoutubeAuthUrl: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }: { input: GetByIdInput }) => {
      return getYoutubeAuthUrl({
        redirectUri: `/collections/youtube/auth`,
        collectionId: input.id,
      });
    }),
  enableYoutubeSupport: moderatorProcedure
    .input(enableCollectionYoutubeSupportInput)
    .mutation(enableCollectionYoutubeSupportHandler),
  getEntryCount: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .query(({ input, ctx }: { input: GetByIdInput; ctx: { user: { id: number } } }) => {
      return getCollectionEntryCount({ collectionId: input.id, userId: ctx.user.id });
    }),
  joinCollectionAsManager: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(getByIdSchema)
    .mutation(joinCollectionAsManagerHandler),
});
