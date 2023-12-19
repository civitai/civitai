import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  clubPostResourceInput,
  clubResourceInput,
  getInfiniteClubPostsSchema,
  upsertClubPostInput,
} from '~/server/schema/club.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteClubPostHandler,
  getClubPostByIdHandler,
  getInfiniteClubPostsHandler,
  getResourceDetailsForClubPostCreationHandler,
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
  resourcePostCreateDetails: protectedProcedure
    .input(clubPostResourceInput)
    .use(isFlagProtected('clubs'))
    .query(getResourceDetailsForClubPostCreationHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .mutation(deleteClubPostHandler),
});
