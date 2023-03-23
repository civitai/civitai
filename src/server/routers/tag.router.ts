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
} from '~/server/controllers/tag.controller';
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
import { getHiddenTagsForUser } from '~/server/services/user-cache.service';
import {
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  const userId = ctx.user?.id;
  const _input = input as { not?: number[] };
  const hidden = await getHiddenTagsForUser({ userId });
  _input.not = [...hidden, ...(_input.not ?? [])];

  return next({
    ctx: { user: ctx.user },
  });
});

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getAll: publicProcedure
    .input(getTagsInput.optional())
    .use(applyUserPreferences)
    .query(getAllTagsHandler),
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
