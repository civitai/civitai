import { CacheTTL } from '~/server/common/constants';
import {
  addTagsHandler,
  addTagVotesHandler,
  getAllTagsHandler,
  getTagWithModelCountHandler,
  getTrendingTagsHandler,
  getVotableTagsHandler,
  removeTagVotesHandler,
  disableTagsHandler,
  getManagableTagsHandler,
  deleteTagsHandler,
  getHomeExcludedTagsHandler,
} from '~/server/controllers/tag.controller';
import { applyUserPreferences, cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addTagVotesSchema,
  adjustTagsSchema,
  deleteTagsSchema,
  getTagByNameSchema,
  getTagsForReviewSchema,
  getTagsInput,
  getTrendingTagsSchema,
  getVotableTagsSchema,
  removeTagVotesSchema,
} from '~/server/schema/tag.schema';
import { getTag, getTagsForReview } from '~/server/services/tag.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input }) => getTag(input)),
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTagsInput.optional())
    .use(applyUserPreferences)
    .use(cacheIt({ ttl: 60 }))
    .query(getAllTagsHandler),
  getHomeExcluded: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(edgeCacheIt({ ttl: 24 * 60 * 60 }))
    .query(getHomeExcludedTagsHandler),
  getTrending: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTrendingTagsSchema)
    .use(applyUserPreferences)
    .query(getTrendingTagsHandler),
  getTagsForReview: moderatorProcedure
    .input(getTagsForReviewSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(({ input }) => getTagsForReview(input)),
  getManagableTags: moderatorProcedure.query(getManagableTagsHandler),
  getVotableTags: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getVotableTagsSchema)
    .query(getVotableTagsHandler),
  addTagVotes: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(addTagVotesSchema)
    .mutation(addTagVotesHandler),
  removeTagVotes: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(removeTagVotesSchema)
    .mutation(removeTagVotesHandler),
  addTags: moderatorProcedure.input(adjustTagsSchema).mutation(addTagsHandler),
  disableTags: moderatorProcedure.input(adjustTagsSchema).mutation(disableTagsHandler),
  deleteTags: moderatorProcedure.input(deleteTagsSchema).mutation(deleteTagsHandler),
});
