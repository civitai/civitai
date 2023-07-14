import {
  saveItemHandler,
  getAllUserCollectionsHandler,
  getUserCollectionsByItemHandler,
  upsertCollectionHandler,
  deleteUserCollectionHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  saveCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
  getUserCollectionsByItemSchema,
  upsertCollectionInput,
} from '~/server/schema/collection.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

export const collectionRouter = router({
  getAllUser: protectedProcedure
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('collections'))
    .query(getAllUserCollectionsHandler),
  upsert: protectedProcedure.input(upsertCollectionInput).mutation(upsertCollectionHandler),
  saveItem: protectedProcedure
    .input(saveCollectionItemInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(saveItemHandler),
  getUserCollectionsByItem: protectedProcedure
    .input(getUserCollectionsByItemSchema)
    .use(isFlagProtected('collections'))
    .query(getUserCollectionsByItemHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('collections'))
    .mutation(deleteUserCollectionHandler),
});
