import {
  getModelVersionRunStrategiesHandler,
  toggleNotifyEarlyAccessHandler,
  upsertModelVersionHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { modelVersionUpsertSchema2 } from '~/server/schema/model-version.schema';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const modelVersionRouter = router({
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
  toggleNotifyEarlyAccess: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('earlyAccessModel'))
    .mutation(toggleNotifyEarlyAccessHandler),
  upsert: protectedProcedure.input(modelVersionUpsertSchema2).mutation(upsertModelVersionHandler),
});
