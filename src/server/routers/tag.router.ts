import {
  addTagsHandler,
  addTagVotesHandler,
  getAllTagsHandler,
  getTagWithModelCountHandler,
  getTrendingTagsHandler,
  getVotableTagsHandler,
  removeTagVotesHandler,
  disableTagsHandler,
  moderateTagsHandler,
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
  getTagsInput,
  getTrendingTagsSchema,
  getVotableTagsSchema,
  moderateTagsSchema,
  removeTagVotesSchema,
} from '~/server/schema/tag.schema';
import { getTag } from '~/server/services/tag.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getById: publicProcedure.input(getByIdSchema).query(({ input }) => getTag(input)),
  getAll: publicProcedure
    .input(getTagsInput.optional())
    .use(applyUserPreferences)
    .use(cacheIt({ ttl: 60 }))
    .query(getAllTagsHandler),
  getHomeExcluded: publicProcedure
    .use(edgeCacheIt({ ttl: 24 * 60 * 60 }))
    .query(getHomeExcludedTagsHandler),
  getTrending: publicProcedure
    .input(getTrendingTagsSchema)
    .use(applyUserPreferences)
    .query(getTrendingTagsHandler),
  getManagableTags: moderatorProcedure.query(getManagableTagsHandler),
  getVotableTags: publicProcedure.input(getVotableTagsSchema).query(getVotableTagsHandler),
  addTagVotes: protectedProcedure.input(addTagVotesSchema).mutation(addTagVotesHandler),
  removeTagVotes: protectedProcedure.input(removeTagVotesSchema).mutation(removeTagVotesHandler),
  addTags: moderatorProcedure.input(adjustTagsSchema).mutation(addTagsHandler),
  disableTags: moderatorProcedure.input(adjustTagsSchema).mutation(disableTagsHandler),
  moderateTags: moderatorProcedure.input(moderateTagsSchema).mutation(moderateTagsHandler),
  deleteTags: moderatorProcedure.input(deleteTagsSchema).mutation(deleteTagsHandler),
});
