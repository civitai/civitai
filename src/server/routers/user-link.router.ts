import {
  getUserLinksHandler,
  upsertManyUserLinksHandler,
} from './../controllers/user-link.controller';
import { getUserLinksSchema, upsertManyUserLinkSchema } from './../schema/user-link.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userLinkRouter = router({
  getAll: publicProcedure.input(getUserLinksSchema).query(getUserLinksHandler),
  upsertMany: protectedProcedure.input(upsertManyUserLinkSchema).query(upsertManyUserLinksHandler),
});
