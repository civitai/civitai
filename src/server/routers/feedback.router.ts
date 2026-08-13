import { TRPCError } from '@trpc/server';
import { createFeedbackSchema, getFeedbackAreaSchema } from '~/server/schema/feedback.schema';
import { createFeedback, isFeedbackAreaEnabled } from '~/server/services/feedback.service';
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';

export const feedbackRouter = router({
  getArea: protectedProcedure.input(getFeedbackAreaSchema).query(async ({ input, ctx }) => {
    const enabled = await isFeedbackAreaEnabled({ area: input.area, userId: ctx.user.id });
    return { enabled };
  }),
  create: guardedProcedure.input(createFeedbackSchema).mutation(async ({ input, ctx }) => {
    const enabled = await isFeedbackAreaEnabled({ area: input.area, userId: ctx.user.id });
    // Rejecting loudly rather than dropping the row: if the area was switched
    // off while someone was typing, they should be told, not thanked.
    if (!enabled)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Feedback is not being collected here right now.',
      });
    return createFeedback({ ...input, userId: ctx.user.id });
  }),
});
