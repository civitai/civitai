import {
  createEntityAppealHandler,
  createReportHandler,
  getRecentAppealsHandler,
} from '~/server/controllers/report.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createEntityAppealSchema,
  createReportInputSchema,
  getLatestAppealSchema,
  getRecentAppealsSchema,
} from '~/server/schema/report.schema';
import { getAppealDetails, getLatestAppeal } from '~/server/services/report.service';
import { guardedProcedureAllowUnverifiedEmail, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const reportRouter = router({
  // Reporting abuse and appealing your own restriction are never gated on email verification.
  create: guardedProcedureAllowUnverifiedEmail
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createReportInputSchema)
    .mutation(createReportHandler),
  // #region [appeal]
  getRecentAppeals: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getRecentAppealsSchema)
    .query(getRecentAppealsHandler),
  getAppealDetails: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getAppealDetails({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  getLatestAppeal: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getLatestAppealSchema)
    .query(({ input, ctx }) => getLatestAppeal({ ...input, userId: ctx.user.id })),
  createAppeal: guardedProcedureAllowUnverifiedEmail
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createEntityAppealSchema)
    .mutation(createEntityAppealHandler),
  // #endregion
});
