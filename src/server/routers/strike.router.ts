import { z } from 'zod';
import {
  createStrikeHandler,
  getMyStrikesHandler,
  acceptTosAfterMuteHandler,
  getMyStrikeSummaryHandler,
  getStrikesHandler,
  getUserStandingsHandler,
  getUserStrikeHistoryHandler,
  voidStrikeHandler,
} from '~/server/controllers/strike.controller';
import {
  createStrikeSchema,
  getMyStrikesSchema,
  getStrikesSchema,
  getUserStandingsSchema,
  voidStrikeSchema,
} from '~/server/schema/strike.schema';
import { isFlagProtected, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const strikeRouter = router({
  // User endpoints
  getMyStrikes: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getMyStrikesSchema)
    .use(isFlagProtected('strikes'))
    .query(getMyStrikesHandler),
  acceptTosAfterMute: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('strikes'))
    .mutation(acceptTosAfterMuteHandler),
  getMyStrikeSummary: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('strikes'))
    .query(getMyStrikeSummaryHandler),

  // Moderator endpoints
  create: moderatorProcedure
    .input(createStrikeSchema)
    .use(isFlagProtected('strikes'))
    .mutation(createStrikeHandler),
  void: moderatorProcedure
    .input(voidStrikeSchema)
    .use(isFlagProtected('strikes'))
    .mutation(voidStrikeHandler),
  getAll: moderatorProcedure
    .input(getStrikesSchema)
    .use(isFlagProtected('strikes'))
    .query(getStrikesHandler),
  getUserStandings: moderatorProcedure
    .input(getUserStandingsSchema)
    .use(isFlagProtected('strikes'))
    .query(getUserStandingsHandler),
  getUserHistory: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .use(isFlagProtected('strikes'))
    .query(getUserStrikeHistoryHandler),
});
