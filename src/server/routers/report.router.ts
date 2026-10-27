import {
  createEntityAppealHandler,
  createReportHandler,
  getRecentAppealsHandler,
} from '~/server/controllers/report.controller';
import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createEntityAppealSchema,
  createReportInputSchema,
  createReportOutputSchema,
  getLatestAppealSchema,
  getRecentAppealsSchema,
} from '~/server/schema/report.schema';
import { submitSiteAppealSchema } from '~/server/schema/site-appeal.schema';
import { getAppealDetails, getLatestAppeal } from '~/server/services/report.service';
import { getSiteAppealState, submitSiteAppeal } from '~/server/services/site-appeal.service';
import { getLockReviewState } from '~/server/services/lock-review.service';
import {
  guardedProcedureAllowUnverifiedEmail,
  protectedProcedure,
  restrictedAccountAppealProcedure,
  router,
} from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const reportRouter = router({
  // Reporting abuse and appealing your own restriction are never gated on email verification.
  create: guardedProcedureAllowUnverifiedEmail
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createReportInputSchema)
    .output(createReportOutputSchema)
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
  getLockReviewState: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getLockReviewState({ modelId: input.id, userId: ctx.user.id })),
  createAppeal: guardedProcedureAllowUnverifiedEmail
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createEntityAppealSchema)
    .mutation(createEntityAppealHandler),
  // #endregion
  // #region [site appeal form] reachable by banned and muted accounts, see `restrictedAccountAppealProcedure`
  getSiteAppealState: restrictedAccountAppealProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getSiteAppealState({ user: ctx.user })),
  submitSiteAppeal: restrictedAccountAppealProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(submitSiteAppealSchema)
    .use(rateLimit({ limit: 5, period: CacheTTL.day }, undefined, { onlyCountSuccess: true }))
    .mutation(({ input, ctx }) => submitSiteAppeal({ user: ctx.user, input })),
  // #endregion
});
