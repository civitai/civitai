import { TRPCError } from '@trpc/server';
import { createFeedbackSchema, getFeedbackAreaSchema } from '~/server/schema/feedback.schema';
import { createFeedback, isFeedbackAreaEnabled } from '~/server/services/feedback.service';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';
import { rateLimit } from '~/server/middleware.trpc';
import { guardedProcedure, router } from '~/server/trpc';

export const feedbackRouter = router({
  // Same procedure level as `create`: anyone who can see the prompt must be able
  // to submit, or a muted user types into a box that will reject them.
  // `ctx.user` (the full server-resolved SessionUser), never a client-supplied id:
  // the flag's context carries cohort properties, so it must be built from what the
  // server knows about the caller. Both procedures pass the SAME thing, which is what
  // keeps the notice and the submit endpoint from disagreeing.
  getArea: guardedProcedure.input(getFeedbackAreaSchema).query(async ({ input, ctx }) => {
    const enabled = await isFeedbackAreaEnabled({ area: input.area, user: ctx.user });
    return { enabled };
  }),
  create: guardedProcedure
    .use(
      rateLimit({
        limit: FEEDBACK_RATE_LIMIT.max,
        period: FEEDBACK_RATE_LIMIT.periodSeconds,
        errorMessage: 'You have submitted a lot of feedback — give it a little while.',
      })
    )
    .input(createFeedbackSchema)
    .mutation(async ({ input, ctx }) => {
      const enabled = await isFeedbackAreaEnabled({ area: input.area, user: ctx.user });
      // Loud rather than dropped: if the area went off mid-typing, say so.
      if (!enabled)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Feedback is not being collected here right now.',
        });
      return createFeedback({ ...input, userId: ctx.user.id });
    }),
});
