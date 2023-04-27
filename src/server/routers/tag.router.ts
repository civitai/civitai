import { BrowsingMode } from '~/server/common/enums';
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
import { cacheIt } from '~/server/middleware.trpc';
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
import { getHiddenTagsForUser } from '~/server/services/user-cache.service';
import {
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  if (ctx.browsingMode !== BrowsingMode.All) {
    const _input = input as { not?: number[] };
    const hidden = await getHiddenTagsForUser({ userId: ctx.user?.id });
    _input.not = [...hidden.hiddenTags, ...hidden.moderatedTags, ...(_input.not ?? [])];

    if (ctx.browsingMode === BrowsingMode.SFW) {
      const systemHidden = await getHiddenTagsForUser({ userId: -1 });
      _input.not = [
        ...systemHidden.hiddenTags,
        ...systemHidden.moderatedTags,
        ...(_input.not ?? []),
      ];
    }
  }

  return next({
    ctx: { user: ctx.user },
  });
});

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
