import {
  addItemHandlers,
  getAllUserCollectionsHandler,
  upsertCollectionHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  addCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
  upsertCollectionInput,
} from '~/server/schema/collection.schema';

export const collectionRouter = router({
  getAllUser: protectedProcedure
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('collections'))
    .query(getAllUserCollectionsHandler),
  upsert: protectedProcedure.input(upsertCollectionInput).mutation(upsertCollectionHandler),
  addItem: protectedProcedure
    .input(addCollectionItemInputSchema)
    .use(isFlagProtected('collections'))
    .mutation(addItemHandlers),
});
