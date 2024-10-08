import { queryModelVersionsForModeratorHandler } from '~/server/controllers/model-version.controller';
import { getModelsPagedSimpleHandler } from '~/server/controllers/model.controller';
import {
  handleApproveTrainingData,
  handleDenyTrainingData,
} from '~/server/controllers/training.controller';
import { getByIdSchema, getByIdsSchema } from '~/server/schema/base.schema';
import { getFlaggedModelsSchema } from '~/server/schema/model-flag.schema';
import { queryModelVersionsSchema } from '~/server/schema/model-version.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { getFlaggedModels, resolveFlaggedModel } from '~/server/services/model-flag.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const modRouter = router({
  models: router({
    query: moderatorProcedure.input(getAllModelsSchema).query(getModelsPagedSimpleHandler),
    queryFlagged: moderatorProcedure
      .input(getFlaggedModelsSchema)
      .query(({ input }) => getFlaggedModels(input)),
    resolveFlagged: moderatorProcedure
      .input(getByIdsSchema)
      .mutation(({ input, ctx }) => resolveFlaggedModel({ ...input, userId: ctx.user.id })),
  }),
  modelVersions: router({
    query: moderatorProcedure
      .input(queryModelVersionsSchema)
      .query(queryModelVersionsForModeratorHandler),
  }),
  trainingData: router({
    approve: moderatorProcedure.input(getByIdSchema).mutation(handleApproveTrainingData),
    deny: moderatorProcedure.input(getByIdSchema).mutation(handleDenyTrainingData),
  }),
});

// // export type definition of API
// export type ModRouter = typeof modRouter;
