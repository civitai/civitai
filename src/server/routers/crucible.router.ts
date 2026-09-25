import {
  cancelCrucibleHandler,
  createCrucibleHandler,
  createEntryPostHandler,
  getCrucibleByIdHandler,
  getCrucibleEntriesHandler,
  getFeaturedCrucibleHandler,
  getInfiniteCruciblesHandler,
  getJudgesCountHandler,
  getJudgeStatsHandler,
  getJudgingPairHandler,
  getUserActiveCruciblesHandler,
  getUserCrucibleStatsHandler,
  submitEntryHandler,
  submitVoteHandler,
} from '~/server/controllers/crucible.controller';
import { isModerator } from '~/server/routers/base.router';
import {
  createEntryPostSchema,
  getCrucibleEntriesSchema,
  cancelCrucibleSchema,
  createCrucibleInputSchema,
  getCrucibleByIdSchema,
  getCruciblesInfiniteSchema,
  getFeaturedCrucibleSchema,
  getJudgesCountSchema,
  getJudgeStatsSchema,
  getJudgingPairSchema,
  getUserActiveCruciblesSchema,
  getUserCrucibleStatsSchema,
  submitEntrySchema,
  submitVoteSchema,
} from '~/server/schema/crucible.schema';
import { guardedProcedure, isFlagProtected, publicProcedure, router } from '~/server/trpc';

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

  create: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(createCrucibleInputSchema)
    .mutation(createCrucibleHandler),

  createEntryPost: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(createEntryPostSchema)
    .mutation(createEntryPostHandler),

  submitEntry: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(submitEntrySchema)
    .mutation(submitEntryHandler),

  getJudgingPair: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgingPairSchema)
    .query(getJudgingPairHandler),

  submitVote: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(submitVoteSchema)
    .mutation(submitVoteHandler),

  cancel: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(isModerator)
    .input(cancelCrucibleSchema)
    .mutation(cancelCrucibleHandler),

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
});
