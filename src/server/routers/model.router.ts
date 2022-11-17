import { getModelHandler } from './../controllers/model.controller';
import { getAllModelsSchema } from './../schema/model.schema';
import { publicProcedure, router } from '~/server/createRouter';
import { getModelsHandler } from '~/server/controllers/model.controller';
import { getByIdSchema } from '~/server/schema/base.schema';

export const modelRouter = router({
  getById: publicProcedure
    .input(getByIdSchema)
    .query(({ ctx, input }) => getModelHandler({ ctx, input })),
  getAll: publicProcedure
    .input(getAllModelsSchema)
    .query(({ ctx, input }) => getModelsHandler({ ctx, input })),
});
