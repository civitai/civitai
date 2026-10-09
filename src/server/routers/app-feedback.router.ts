import { rateLimit } from '~/server/middleware.trpc';
import {
  createAppFeedbackSchema,
  flagAppFeedbackSchema,
  getAppFeedbackEligibilitySchema,
  hasAnyAppFeedbackForListingSchema,
  listAppFeedbackForListingSchema,
  modListAppFeedbackSchema,
  modSetAppFeedbackHiddenSchema,
  setAppFeedbackOwnerStatusSchema,
} from '~/server/schema/app-feedback.schema';
import {
  countNewAppFeedbackForMyListings,
  createAppFeedback,
  flagAppFeedbackAbusive,
  getAppFeedbackEligibility,
  hasAnyAppFeedbackForListing,
  listAppFeedbackForListing,
  modCountFlaggedAppFeedback,
  modListAppFeedback,
  modSetAppFeedbackHidden,
  setAppFeedbackOwnerStatus,
} from '~/server/services/blocks/app-feedback.service';
import {
  guardedProcedureAllowUnverifiedEmail,
  moderatorProcedure,
  protectedProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';

/**
 * Private per-app feedback (`Feedback.area = 'app-block'`). The generic `feedback.create` refuses
 * this area, so every `app-block` row is written here, against a listing the server resolved.
 */
export const appFeedbackRouter = router({
  // `verifiedProcedure`, not `protectedProcedure`: `create` requires onboarding too, and the item
  // must not be offered to someone the submit would refuse.
  getEligibility: verifiedProcedure
    .input(getAppFeedbackEligibilitySchema)
    .query(({ ctx, input }) => getAppFeedbackEligibility(ctx.user, input.target)),

  create: guardedProcedureAllowUnverifiedEmail
    .use(
      rateLimit({
        limit: FEEDBACK_RATE_LIMIT.max,
        period: FEEDBACK_RATE_LIMIT.periodSeconds,
        errorMessage: 'You have submitted a lot of feedback — give it a little while.',
      })
    )
    .input(createAppFeedbackSchema)
    .mutation(({ ctx, input }) => createAppFeedback({ user: ctx.user, input })),

  listForListing: protectedProcedure
    .input(listAppFeedbackForListingSchema)
    .query(({ ctx, input }) => listAppFeedbackForListing({ userId: ctx.user.id, input })),

  // Whether the editor offers the Feedback tab at all. Same authz and visibility as the list.
  hasAnyForListing: protectedProcedure
    .input(hasAnyAppFeedbackForListingSchema)
    .query(({ ctx, input }) => hasAnyAppFeedbackForListing({ userId: ctx.user.id, input })),

  setOwnerStatus: protectedProcedure
    .input(setAppFeedbackOwnerStatusSchema)
    .mutation(({ ctx, input }) => setAppFeedbackOwnerStatus({ userId: ctx.user.id, input })),

  flagAbusive: protectedProcedure
    .input(flagAppFeedbackSchema)
    .mutation(({ ctx, input }) => flagAppFeedbackAbusive({ userId: ctx.user.id, input })),

  countNewForMyListings: protectedProcedure.query(({ ctx }) =>
    countNewAppFeedbackForMyListings(ctx.user.id)
  ),

  modList: moderatorProcedure
    .input(modListAppFeedbackSchema)
    .query(({ input }) => modListAppFeedback(input)),

  modCountFlagged: moderatorProcedure.query(() => modCountFlaggedAppFeedback()),

  modSetHidden: moderatorProcedure
    .input(modSetAppFeedbackHiddenSchema)
    .mutation(({ ctx, input }) => modSetAppFeedbackHidden({ moderatorId: ctx.user.id, input })),
});
