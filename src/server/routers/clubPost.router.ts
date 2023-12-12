import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import { getInfiniteClubPostsSchema, upsertClubPostInput } from '~/server/schema/club.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteClubPostHandler,
  getClubPostByIdHandler,
  getInfiniteClubPostsHandler,
  upsertClubPostHandler,
} from '~/server/controllers/clubPost.controller';

export const clubPostRouter = router({
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .query(getClubPostByIdHandler),
  getInfiniteClubPosts: publicProcedure
    .input(getInfiniteClubPostsSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubPostsHandler),
  upsertClubPost: protectedProcedure
    .input(upsertClubPostInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubPostHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .mutation(deleteClubPostHandler),
});
