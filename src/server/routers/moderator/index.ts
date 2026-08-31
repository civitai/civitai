import * as z from 'zod';
import { getModelsPagedSimpleHandler } from '~/server/controllers/model.controller';
import { getByIdSchema, getByIdsSchema } from '~/server/schema/base.schema';
import {
  modCashAdjustmentSchema,
  updateCashWithdrawalSchema,
} from '~/server/schema/creator-program.schema';
import { getFlaggedModelsSchema } from '~/server/schema/model-flag.schema';
import { getAllModelsSchema, transferModelOwnershipSchema } from '~/server/schema/model.schema';
import {
  getAutoFlaggedMinorDetailSchema,
  getAutoFlaggedMinorModelsSchema,
  getMinorFlagAppealsSchema,
  getMinorHashMatchDetailSchema,
  getMinorHashMatchesSchema,
  resolveMinorFlagAppealSchema,
} from '~/server/schema/minor-hash.schema';
import {
  getCash,
  getWithdrawalHistory,
  modAdjustCashBalance,
  updateCashWithdrawal,
} from '~/server/services/creator-program.service';
import { getModelChangeHistory } from '~/server/services/entity-change.service';
import { getImagesModRules } from '~/server/services/image.service';
import { getFlaggedModels, resolveFlaggedModel } from '~/server/services/model-flag.service';
import {
  getModelModerationDetail,
  getModelModRules,
  transferModelOwnership,
} from '~/server/services/model.service';
import {
  confirmMinorHashAutoFlag,
  dismissMinorHashMatch,
  getAutoFlaggedMinorDetail,
  getAutoFlaggedMinorModels,
  getMinorFlagAppealsForReview,
  getMinorHashMatchDetail,
  getMinorHashMatchesForReview,
  resolveMinorFlagAppeal,
  revertMinorHashAutoFlag,
} from '~/server/services/minor-hash.service';
import { moderatorProcedure, router, isFlagProtected } from '~/server/trpc';

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
    transferOwnership: moderatorProcedure
      .input(transferModelOwnershipSchema)
      .mutation(({ input, ctx }) => transferModelOwnership({ ...input, modUserId: ctx.user.id })),
    getModerationDetail: moderatorProcedure
      .input(getByIdSchema)
      .query(({ input }) => getModelModerationDetail(input)),
    getChangeHistory: moderatorProcedure
      .input(getByIdSchema)
      .query(({ input }) => getModelChangeHistory({ modelId: input.id })),
    queryMinorHashMatches: moderatorProcedure
      .input(getMinorHashMatchesSchema)
      .query(({ input }) => getMinorHashMatchesForReview(input)),
    queryMinorHashMatchDetail: moderatorProcedure
      .input(getMinorHashMatchDetailSchema)
      .query(({ input }) => getMinorHashMatchDetail(input)),
    dismissMinorHashMatch: moderatorProcedure
      .input(getByIdSchema)
      .mutation(({ input, ctx }) =>
        dismissMinorHashMatch({ modelId: input.id, userId: ctx.user.id })
      ),
    queryAutoFlaggedMinorModels: moderatorProcedure
      .input(getAutoFlaggedMinorModelsSchema)
      .query(({ input }) => getAutoFlaggedMinorModels(input)),
    queryAutoFlaggedMinorDetail: moderatorProcedure
      .input(getAutoFlaggedMinorDetailSchema)
      .query(({ input }) => getAutoFlaggedMinorDetail(input)),
    confirmMinorHashAutoFlag: moderatorProcedure
      .input(getByIdSchema)
      .mutation(({ input, ctx }) =>
        confirmMinorHashAutoFlag({ modelId: input.id, userId: ctx.user.id })
      ),
    revertMinorHashAutoFlag: moderatorProcedure
      .input(getByIdSchema)
      .mutation(({ input, ctx }) =>
        revertMinorHashAutoFlag({ modelId: input.id, userId: ctx.user.id })
      ),
    queryMinorFlagAppeals: moderatorProcedure
      .input(getMinorFlagAppealsSchema)
      .query(({ input }) => getMinorFlagAppealsForReview(input)),
    resolveMinorFlagAppeal: moderatorProcedure
      .input(resolveMinorFlagAppealSchema)
      .mutation(({ input, ctx }) => resolveMinorFlagAppeal({ ...input, userId: ctx.user.id })),
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
