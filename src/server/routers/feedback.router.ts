import { TRPCError } from '@trpc/server';
import { createFeedbackSchema, getFeedbackAreaSchema } from '~/server/schema/feedback.schema';
import {
  buildFeedbackServerStamp,
  createFeedback,
  FEEDBACK_AREA_DISABLED_MESSAGE,
  isFeedbackAreaEnabled,
} from '~/server/services/feedback.service';
import { captureFeedbackScreenshot } from '~/server/services/feedback-capture.service';
import { fileFeedbackToHq } from '~/server/services/feedback-hq.service';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';
import { rateLimit } from '~/server/middleware.trpc';
import { guardedProcedureAllowUnverifiedEmail, router } from '~/server/trpc';

export const feedbackRouter = router({
  // Same procedure level as `create`: anyone who can see the prompt must be able
  // to submit, or a muted user types into a box that will reject them.
  // `ctx.user` (the full server-resolved SessionUser), never a client-supplied id:
  // the flag's context carries cohort properties, so it must be built from what the
  // server knows about the caller. Both procedures pass the SAME thing, which is what
  // keeps the notice and the submit endpoint from disagreeing.
  getArea: guardedProcedureAllowUnverifiedEmail
    .input(getFeedbackAreaSchema)
    .query(async ({ input, ctx }) => {
      const enabled = await isFeedbackAreaEnabled({ area: input.area, user: ctx.user });
      return { enabled };
    }),
  create: guardedProcedureAllowUnverifiedEmail
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
        throw new TRPCError({ code: 'FORBIDDEN', message: FEEDBACK_AREA_DISABLED_MESSAGE });
      const server = buildFeedbackServerStamp({
        headers: ctx.req?.headers ?? {},
        tier: ctx.user.tier,
        domain: ctx.domain,
        features: ctx.features,
      });
      const saved = await createFeedback({ ...input, userId: ctx.user.id, server });
      // Not awaited: the capture and HQ must never delay or fail the submit. Neither throws.
      void captureFeedbackScreenshot({
        feedbackId: saved.id,
        reporterId: ctx.user.id,
        screenshotId: input.context?.screenshotId,
      }).then((capture) =>
        fileFeedbackToHq({ ...input, feedbackId: saved.id, userId: ctx.user.id, server, capture })
      );
      return saved;
    }),
});
