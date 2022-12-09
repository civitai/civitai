import { getModelVersionRunStrategiesHandler } from './../controllers/model-version.controller';
import { getByIdSchema } from './../schema/base.schema';
import { publicProcedure } from './../trpc';
import { router } from '~/server/trpc';

export const modelVersionRouter = router({
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
});
