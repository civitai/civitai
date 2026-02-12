import { z } from 'zod';
import {
  createStrikeHandler,
  getMyStrikesHandler,
  getMyStrikeSummaryHandler,
  getStrikesHandler,
  getUserStrikeHistoryHandler,
  voidStrikeHandler,
} from '~/server/controllers/strike.controller';
import {
  createStrikeSchema,
  getMyStrikesSchema,
  getStrikesSchema,
  voidStrikeSchema,
} from '~/server/schema/strike.schema';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const strikeRouter = router({
  // User endpoints
  getMyStrikes: protectedProcedure.input(getMyStrikesSchema).query(getMyStrikesHandler),
  getMyStrikeSummary: protectedProcedure.query(getMyStrikeSummaryHandler),

  // Moderator endpoints
  create: moderatorProcedure.input(createStrikeSchema).mutation(createStrikeHandler),
  void: moderatorProcedure.input(voidStrikeSchema).mutation(voidStrikeHandler),
  getAll: moderatorProcedure.input(getStrikesSchema).query(getStrikesHandler),
  getUserHistory: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .query(getUserStrikeHistoryHandler),
});
