import { getByIdSchema } from './../schema/base.schema';
import {
  deleteUserLinkHandler,
  getUserLinksHandler,
  upsertManyUserLinksHandler,
  upsertUserLinkHandler,
} from './../controllers/user-link.controller';
import {
  getUserLinksSchema,
  upsertManyUserLinkSchema,
  upsertUserLinkSchema,
} from './../schema/user-link.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userLinkRouter = router({
  getAll: publicProcedure.input(getUserLinksSchema).query(getUserLinksHandler),
  upsertMany: protectedProcedure
    .input(upsertManyUserLinkSchema)
    .mutation(upsertManyUserLinksHandler),
  upsert: protectedProcedure.input(upsertUserLinkSchema).mutation(upsertUserLinkHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteUserLinkHandler),
});
