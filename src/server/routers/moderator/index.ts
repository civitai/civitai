import * as z from 'zod';
import { queryModelVersionsForModeratorHandler } from '~/server/controllers/model-version.controller';
import { getModelsPagedSimpleHandler } from '~/server/controllers/model.controller';
import {
  handleApproveTrainingData,
  handleDenyTrainingData,
} from '~/server/controllers/training.controller';
import { getByIdSchema, getByIdsSchema } from '~/server/schema/base.schema';
import {
  modCashAdjustmentSchema,
  updateCashWithdrawalSchema,
} from '~/server/schema/creator-program.schema';
import { getFlaggedModelsSchema } from '~/server/schema/model-flag.schema';
import { queryModelVersionsSchema } from '~/server/schema/model-version.schema';
import {
  getAllModelsSchema,
  getTrainingModerationFeedSchema,
  transferModelOwnershipSchema,
} from '~/server/schema/model.schema';
import {
  getCash,
  getWithdrawalHistory,
  modAdjustCashBalance,
  updateCashWithdrawal,
} from '~/server/services/creator-program.service';
import { getFlaggedModels, resolveFlaggedModel } from '~/server/services/model-flag.service';
import {
  getModelModerationDetail,
  getModelModRules,
  getTrainingModelsForModerators,
  transferModelOwnership,
} from '~/server/services/model.service';
import { moderatorProcedure, protectedProcedure, router, isFlagProtected } from '~/server/trpc';

const trainingModerationProcedure = protectedProcedure.use(
  isFlagProtected('trainingModelsModeration')
);

const cashManagementProcedure = moderatorProcedure.use(isFlagProtected('cashManagement'));

export const modRouter = router({
  models: router({
    query: moderatorProcedure.input(getAllModelsSchema).query(getModelsPagedSimpleHandler),
    queryFlagged: moderatorProcedure
      .input(getFlaggedModelsSchema)
      .query(({ input }) => getFlaggedModels(input)),
    resolveFlagged: moderatorProcedure
      .input(getByIdsSchema)
      .mutation(({ input, ctx }) => resolveFlaggedModel({ ...input, userId: ctx.user.id })),
    queryTraining: trainingModerationProcedure
      .input(getTrainingModerationFeedSchema)
      .query(({ input }) => getTrainingModelsForModerators(input)),
    transferOwnership: moderatorProcedure
      .input(transferModelOwnershipSchema)
      .mutation(({ input, ctx }) => transferModelOwnership({ ...input, modUserId: ctx.user.id })),
    getModerationDetail: moderatorProcedure
      .input(getByIdSchema)
      .query(({ input }) => getModelModerationDetail(input)),
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
  cash: router({
    getCashForUser: cashManagementProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(({ input }) => getCash(input.userId)),
    getWithdrawalHistory: cashManagementProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(({ input }) => getWithdrawalHistory(input.userId)),
    adjustBalance: cashManagementProcedure
      .input(modCashAdjustmentSchema)
      .mutation(({ input, ctx }) => modAdjustCashBalance({ ...input, modUserId: ctx.user.id })),
    updateWithdrawal: cashManagementProcedure
      .input(updateCashWithdrawalSchema)
      .mutation(({ input }) => updateCashWithdrawal(input)),
  }),
});

// // export type definition of API
// export type ModRouter = typeof modRouter;
