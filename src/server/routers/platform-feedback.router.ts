import { rateLimit } from '~/server/middleware.trpc';
import {
  createPlatformFeedbackSchema,
  getPlatformFeedbackStatusSchema,
} from '~/server/schema/platform-feedback.schema';
import {
  createPlatformFeedback,
  getPlatformFeedbackStatus,
} from '~/server/services/platform-feedback.service';
import { guardedProcedureAllowUnverifiedEmail, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `AppBlocksSubmit` is opt-in, so a token holding only ordinary scopes stays refused.
const agentTokenScope = { requiredScope: TokenScope.AppBlocksSubmit } as const;

const HOUR = 60 * 60;
export const PLATFORM_FEEDBACK_CREATE_RATE_LIMITS = [
  { limit: 10, period: HOUR },
  { limit: 40, period: 24 * HOUR },
].map((limit) => ({
  ...limit,
  errorMessage: 'You have sent a lot of platform feedback. Try again later.',
}));
export const PLATFORM_FEEDBACK_STATUS_RATE_LIMIT = { limit: 60, period: 60 };

/** The generic `feedback.create` refuses the `apps-platform` area, so every row is written here. */
export const platformFeedbackRouter = router({
  create: guardedProcedureAllowUnverifiedEmail
    .meta(agentTokenScope)
    .use(rateLimit(PLATFORM_FEEDBACK_CREATE_RATE_LIMITS))
    .input(createPlatformFeedbackSchema)
    .mutation(({ ctx, input }) => createPlatformFeedback({ user: ctx.user, input })),

  getStatus: guardedProcedureAllowUnverifiedEmail
    .meta(agentTokenScope)
    .use(rateLimit(PLATFORM_FEEDBACK_STATUS_RATE_LIMIT))
    .input(getPlatformFeedbackStatusSchema)
    .query(({ ctx, input }) => getPlatformFeedbackStatus({ user: ctx.user, input })),
});
