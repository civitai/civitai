import {
  saveItemHandler,
  getAllUserCollectionsHandler,
  upsertCollectionHandler,
  deleteUserCollectionHandler,
  getCollectionByIdHandler,
  followHandler,
  unfollowHandler,
  getUserCollectionItemsByItemHandler,
  collectionItemsInfiniteHandler,
  updateCollectionItemsStatusHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  saveCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
  getUserCollectionItemsByItemSchema,
  upsertCollectionInput,
  followCollectionInputSchema,
  getAllCollectionItemsSchema,
  updateCollectionItemsStatusInput,
} from '~/server/schema/collection.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

export const collectionRouter = router({
  getAllUser: protectedProcedure
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('collections'))
    .query(getAllUserCollectionsHandler),
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .query(getCollectionByIdHandler),
  upsert: protectedProcedure.input(upsertCollectionInput).mutation(upsertCollectionHandler),
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
    .mutation(deleteUserCollectionHandler),
});
