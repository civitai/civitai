import {
  cancelCrucibleHandler,
  removeCrucibleEntryHandler,
  withdrawCrucibleEntryHandler,
  updateCrucibleHandler,
  checkEntryEligibilityHandler,
  getCreateEligibilityHandler,
  getJudgeEligibilityHandler,
  createCrucibleHandler,
  createEntryPostHandler,
  getCrucibleByIdHandler,
  getCrucibleEntriesHandler,
  getFeaturedCrucibleHandler,
  getInfiniteCruciblesHandler,
  getJudgesCountHandler,
  getJudgeStatsHandler,
  getJudgingPairHandler,
  getJudgingSuggestionsHandler,
  getMinVotesToPlaceHandler,
  getRequiredModelsHandler,
  getJudgingProgressHandler,
  getJudgingStatusesHandler,
  getUserActiveCruciblesHandler,
  getUserCrucibleStatsHandler,
  submitEntryHandler,
  submitVoteHandler,
} from '~/server/controllers/crucible.controller';
import { rateLimit } from '~/server/middleware.trpc';
import {
  checkCrucibleEntryEligibilitySchema,
  createEntryPostSchema,
  getCrucibleEntriesSchema,
  cancelCrucibleSchema,
  removeCrucibleEntrySchema,
  withdrawCrucibleEntrySchema,
  updateCrucibleSchema,
  createCrucibleInputSchema,
  getCrucibleByIdSchema,
  getCrucibleRequiredModelsSchema,
  getJudgingProgressSchema,
  getJudgingStatusesSchema,
  getCruciblesInfiniteSchema,
  getFeaturedCrucibleSchema,
  getJudgesCountSchema,
  getJudgeStatsSchema,
  getJudgingPairSchema,
  getJudgingSuggestionsSchema,
  getUserActiveCruciblesSchema,
  getUserCrucibleStatsSchema,
  submitEntrySchema,
  submitVoteSchema,
  toggleCrucibleFollowSchema,
} from '~/server/schema/crucible.schema';
import {
  getFollowedCrucibleIds,
  toggleCrucibleFollow,
} from '~/server/services/crucible-engagement.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

export const crucibleRouter = router({
  getInfinite: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCruciblesInfiniteSchema)
    .query(getInfiniteCruciblesHandler),

  getById: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCrucibleByIdSchema)
    .query(getCrucibleByIdHandler),

  getEntries: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCrucibleEntriesSchema)
    .query(getCrucibleEntriesHandler),

  getRequiredModels: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCrucibleRequiredModelsSchema)
    .query(getRequiredModelsHandler),

  getMinVotesToPlace: protectedProcedure
    .use(isFlagProtected('crucible'))
    .input(getCrucibleByIdSchema)
    .query(getMinVotesToPlaceHandler),

  getCreateEligibility: protectedProcedure
    .use(isFlagProtected('crucible'))
    .query(getCreateEligibilityHandler),

  getJudgeEligibility: protectedProcedure
    .use(isFlagProtected('crucible'))
    .query(getJudgeEligibilityHandler),

  create: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(createCrucibleInputSchema)
    .mutation(createCrucibleHandler),

  createEntryPost: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(createEntryPostSchema)
    .mutation(createEntryPostHandler),

  checkEntryEligibility: protectedProcedure
    .use(isFlagProtected('crucible'))
    .input(checkCrucibleEntryEligibilitySchema)
    .query(checkEntryEligibilityHandler),

  submitEntry: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(submitEntrySchema)
    .mutation(submitEntryHandler),

  getJudgingPair: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(rateLimit({ limit: 120, period: 60 }))
    .input(getJudgingPairSchema)
    .query(getJudgingPairHandler),

  getJudgingProgress: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(rateLimit({ limit: 120, period: 60 }))
    .input(getJudgingProgressSchema)
    .query(getJudgingProgressHandler),

  // protectedProcedure: a read on the feed, so a muted user must not get FORBIDDEN here.
  getJudgingStatuses: protectedProcedure
    .use(isFlagProtected('crucible'))
    .use(rateLimit({ limit: 60, period: 60 }))
    .input(getJudgingStatusesSchema)
    .query(getJudgingStatusesHandler),

  submitVote: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(rateLimit({ limit: 60, period: 60 }))
    .input(submitVoteSchema)
    .mutation(submitVoteHandler),

  cancel: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(cancelCrucibleSchema)
    .mutation(cancelCrucibleHandler),

  removeEntry: moderatorProcedure
    .use(isFlagProtected('crucible'))
    .input(removeCrucibleEntrySchema)
    .mutation(removeCrucibleEntryHandler),

  withdrawEntry: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(withdrawCrucibleEntrySchema)
    .mutation(withdrawCrucibleEntryHandler),

  update: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(updateCrucibleSchema)
    .mutation(updateCrucibleHandler),

  getUserStats: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getUserCrucibleStatsSchema)
    .query(getUserCrucibleStatsHandler),

  getUserActiveCrucibles: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getUserActiveCruciblesSchema)
    .query(getUserActiveCruciblesHandler),

  getFeatured: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getFeaturedCrucibleSchema)
    .query(getFeaturedCrucibleHandler),

  getJudgesCount: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgesCountSchema)
    .query(getJudgesCountHandler),

  getJudgeStats: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgeStatsSchema)
    .query(getJudgeStatsHandler),

  getJudgingSuggestions: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgingSuggestionsSchema)
    .query(getJudgingSuggestionsHandler),

  toggleFollow: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(toggleCrucibleFollowSchema)
    .mutation(({ input, ctx }) =>
      toggleCrucibleFollow({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  getFollowedIds: protectedProcedure
    .use(isFlagProtected('crucible'))
    .query(({ ctx }) => getFollowedCrucibleIds(ctx.user.id)),
});
