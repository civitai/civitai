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
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const clubPostRouter = router({
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .query(getClubPostByIdHandler),
  getInfiniteClubPosts: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteClubPostsSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubPostsHandler),
  upsertClubPost: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(upsertClubPostInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubPostHandler),
  resourcePostCreateDetails: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(clubPostResourceInput)
    .use(isFlagProtected('clubs'))
    .query(getResourceDetailsForClubPostCreationHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .mutation(deleteClubPostHandler),
});
