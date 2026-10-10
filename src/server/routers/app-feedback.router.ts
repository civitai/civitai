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
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `AppBlocksSubmit`, the bit the CLI's other app-management calls require (see
 * `blocks.getMyAppAnalytics`), not a bit inside `Full`: it is opt-in, so a token holding only
 * ordinary scopes stays refused. Only the four procedures a token caller needs carry it.
 * `hasAnyForListing` is left out because only the web editor calls it and `listForListing`
 * already answers it; `getEligibility`, `create` and `mod*` because they would let a token file
 * feedback as the user or carry moderator reach. Annotate by what a token caller needs, not to
 * match a sibling.
 */
const ownerInboxTokenScope = { requiredScope: TokenScope.AppBlocksSubmit } as const;

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
    .meta(ownerInboxTokenScope)
    .input(listAppFeedbackForListingSchema)
    .query(({ ctx, input }) => listAppFeedbackForListing({ userId: ctx.user.id, input })),

  // Whether the editor offers the Feedback tab at all. Same authz and visibility as the list.
  hasAnyForListing: protectedProcedure
    .input(hasAnyAppFeedbackForListingSchema)
    .query(({ ctx, input }) => hasAnyAppFeedbackForListing({ userId: ctx.user.id, input })),

  setOwnerStatus: protectedProcedure
    .meta(ownerInboxTokenScope)
    .input(setAppFeedbackOwnerStatusSchema)
    .mutation(({ ctx, input }) => setAppFeedbackOwnerStatus({ userId: ctx.user.id, input })),

  flagAbusive: protectedProcedure
    .meta(ownerInboxTokenScope)
    .input(flagAppFeedbackSchema)
    .mutation(({ ctx, input }) => flagAppFeedbackAbusive({ userId: ctx.user.id, input })),

  countNewForMyListings: protectedProcedure
    .meta(ownerInboxTokenScope)
    .query(({ ctx }) => countNewAppFeedbackForMyListings(ctx.user.id)),

  modList: moderatorProcedure
    .input(modListAppFeedbackSchema)
    .query(({ input }) => modListAppFeedback(input)),

  modCountFlagged: moderatorProcedure.query(() => modCountFlaggedAppFeedback()),

  modSetHidden: moderatorProcedure
    .input(modSetAppFeedbackHiddenSchema)
    .mutation(({ ctx, input }) => modSetAppFeedbackHidden({ moderatorId: ctx.user.id, input })),
});
