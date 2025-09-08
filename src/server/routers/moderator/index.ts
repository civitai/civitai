import * as z from 'zod';
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
import { getImagesModRules } from '~/server/services/image.service';
import { getFlaggedModels, resolveFlaggedModel } from '~/server/services/model-flag.service';
import { getModelModRules, getTrainingModelsForModerators } from '~/server/services/model.service';
import { moderatorProcedure, router } from '~/server/trpc';
import { throwDbError } from '~/server/utils/errorHandling';
import type { ModerationRule } from '~/shared/utils/prisma/models';

export const modRouter = router({
  models: router({
    query: moderatorProcedure.input(getAllModelsSchema).query(getModelsPagedSimpleHandler),
    queryFlagged: moderatorProcedure
      .input(getFlaggedModelsSchema)
      .query(({ input }) => getFlaggedModels(input)),
    resolveFlagged: moderatorProcedure
      .input(getByIdsSchema)
      .mutation(({ input, ctx }) => resolveFlaggedModel({ ...input, userId: ctx.user.id })),
    queryTraining: moderatorProcedure
      .input(z.object({ limit: z.number().optional(), cursor: z.number().optional() }))
      .query(({ input }) => getTrainingModelsForModerators(input)),
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
  rules: router({
    getById: moderatorProcedure
      .input(getByIdSchema.extend({ entityType: z.enum(['Model', 'Image']) }))
      .query(async ({ input }) => {
        const { id, entityType } = input;
        let modRule: Pick<ModerationRule, 'id' | 'action' | 'definition'> | undefined;

        if (entityType === 'Model') {
          const modelModRules = await getModelModRules();
          modRule = modelModRules.find((rule) => rule.id === id);
        } else {
          const imageModRules = await getImagesModRules();
          modRule = imageModRules.find((rule) => rule.id === id);
        }

        if (!modRule) throw throwDbError('Rule not found');
        return modRule;
      }),
  }),
});

// // export type definition of API
// export type ModRouter = typeof modRouter;
