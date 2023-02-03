import {
  getModelVersionRunStrategiesHandler,
  toggleNotifyEarlyAccessHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const modelVersionRouter = router({
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
  toggleNotifyEarlyAccess: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('earlyAccessModel'))
    .mutation(toggleNotifyEarlyAccessHandler),
});
