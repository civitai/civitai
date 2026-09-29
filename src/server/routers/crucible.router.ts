import {
  cancelCrucibleHandler,
  updateCrucibleHandler,
  checkEntryEligibilityHandler,
  getCreateEligibilityHandler,
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
  updateCrucibleSchema,
  createCrucibleInputSchema,
  getCrucibleByIdSchema,
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
} from '~/server/schema/crucible.schema';
import {
  guardedProcedure,
  isFlagProtected,
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

  getCreateEligibility: protectedProcedure
    .use(isFlagProtected('crucible'))
    .query(getCreateEligibilityHandler),

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

  submitVote: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(rateLimit({ limit: 60, period: 60 }))
    .input(submitVoteSchema)
    .mutation(submitVoteHandler),

  cancel: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(cancelCrucibleSchema)
    .mutation(cancelCrucibleHandler),

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
});
