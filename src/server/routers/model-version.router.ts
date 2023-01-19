import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';
import {
  getModelVersionRunStrategiesHandler,
  toggleNotifyEarlyAccessHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';

const isFlagProtected = middleware(({ ctx, next }) => {
  const { earlyAccessModel } = getFeatureFlags({ user: ctx.user });
  if (!earlyAccessModel) throw new TRPCError({ code: 'FORBIDDEN' });

  return next({ ctx: { user: ctx.user as SessionUser } });
});

export const modelVersionRouter = router({
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
  toggleNotifyEarlyAccess: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected)
    .mutation(toggleNotifyEarlyAccessHandler),
});
