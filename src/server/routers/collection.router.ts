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
} from '~/server/schema/collection.schema';
import { getCollectionEntryCount } from '~/server/services/collection.service';
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
    .input(getAllCollectionsInfiniteSchema)
    .use(isFlagProtected('profileCollections'))
    .query(getAllCollectionsInfiniteHandler),
  getAllUser: protectedProcedure
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('collections'))
    .query(getAllUserCollectionsHandler),
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .query(getCollectionByIdHandler),
  upsert: guardedProcedure
    .input(upsertCollectionInput)
    .use(isOwnerOrModerator)
    .mutation(upsertCollectionHandler),
  updateCoverImage: guardedProcedure
    .input(updateCollectionCoverImageInput)
    .mutation(updateCollectionCoverImageHandler),
  saveItem: protectedProcedure
    .input(saveCollectionItemInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(saveItemHandler),
  follow: protectedProcedure
    .input(followCollectionInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(followHandler),
  unfollow: protectedProcedure
    .input(followCollectionInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(unfollowHandler),
  getUserCollectionItemsByItem: protectedProcedure
    .input(getUserCollectionItemsByItemSchema)
    .use(isFlagProtected('collections'))
    .query(getUserCollectionItemsByItemHandler),
  getAllCollectionItems: protectedProcedure
    .input(getAllCollectionItemsSchema)
    .use(isFlagProtected('collections'))
    .query(collectionItemsInfiniteHandler),
  updateCollectionItemsStatus: protectedProcedure
    .input(updateCollectionItemsStatusInput)
    .use(isFlagProtected('collections'))
    .mutation(updateCollectionItemsStatusHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .use(isOwnerOrModerator)
    .mutation(deleteUserCollectionHandler),
  bulkSaveItems: protectedProcedure
    .input(bulkSaveCollectionItemsInput)
    .use(isFlagProtected('collections'))
    .mutation(bulkSaveItemsHandler),
  addSimpleImagePost: protectedProcedure
    .input(addSimpleImagePostInput)
    .use(isFlagProtected('collections'))
    .mutation(addSimpleImagePostHandler),
  getPermissionDetails: protectedProcedure
    .input(getCollectionPermissionDetails)
    .use(isFlagProtected('collections'))
    .query(getPermissionDetailsHandler),
  removeFromCollection: protectedProcedure
    .input(removeCollectionItemInput)
    .use(isFlagProtected('collections'))
    .mutation(removeCollectionItemHandler),
  setItemScore: guardedProcedure
    .input(setItemScoreInput)
    .use(isFlagProtected('collections'))
    .mutation(setItemScoreHandler),
  updateCollectionItemNSFWLevel: guardedProcedure
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
    .input(getByIdSchema)
    .query(({ input, ctx }: { input: GetByIdInput; ctx: { user: { id: number } } }) => {
      return getCollectionEntryCount({ collectionId: input.id, userId: ctx.user.id });
    }),
  joinCollectionAsManager: protectedProcedure
    .input(getByIdSchema)
    .mutation(joinCollectionAsManagerHandler),
});
