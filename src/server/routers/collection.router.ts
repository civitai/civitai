import {
  saveItemHandler,
  getAllUserCollectionsHandler,
  getUserCollectionsByItemHandler,
  upsertCollectionHandler,
  deleteUserCollectionHandler,
  getCollectionByIdHandler,
} from '~/server/controllers/collection.controller';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  saveCollectionItemInputSchema,
  getAllUserCollectionsInputSchema,
  getUserCollectionsByItemSchema,
  upsertCollectionInput,
  FollowCollectionInput,
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
    .input(FollowCollectionInput)
    .use(isFlagProtected('collections'))
    .mutation(saveItemHandler),
  unfollow: protectedProcedure
    .input(FollowCollectionInput)
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
