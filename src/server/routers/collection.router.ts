import {
  saveItemHandler,
  getAllUserCollectionsHandler,
  upsertCollectionHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  saveCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
  upsertCollectionInput,
} from '~/server/schema/collection.schema';

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
});
