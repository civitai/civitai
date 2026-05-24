import {
  getEarningsThisMonthSchema,
  getModelPerformanceSchema,
  getSourceMixSchema,
} from '~/server/schema/creator-earnings.schema';
import {
  getEarningsThisMonth,
  getModelPerformance,
  getSourceMix,
} from '~/server/services/creator-earnings.service';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const creatorRouter = router({
  getEarningsThisMonth: protectedProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getEarningsThisMonthSchema)
    .query(({ ctx }) => getEarningsThisMonth({ userId: ctx.user.id })),
  getModelPerformance: protectedProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getModelPerformanceSchema)
    .query(({ ctx, input }) => getModelPerformance({ userId: ctx.user.id, ...input })),
  getSourceMix: protectedProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getSourceMixSchema)
    .query(({ ctx, input }) => getSourceMix({ userId: ctx.user.id, ...input })),
});
