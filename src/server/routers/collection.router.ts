import {
  addItemHandlers,
  getAllUserCollectionsHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  addCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
} from '~/server/schema/collection.schema';

export const collectionRouter = router({
  getAllUser: publicProcedure
    .input(getAllUserCollectionsInputSchema)
    .use(isFlagProtected('alternateHome'))
    .query(getAllUserCollectionsHandler),
  addItems: protectedProcedure
    .input(addCollectionItemInputSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(addItemHandlers),
});
