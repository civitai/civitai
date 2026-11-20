import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { setServiceDealReviewHidden } from '~/server/services/creator-service-deal-review.service';
import { hasModeratorPageAccess } from '~/server/services/moderator-grants';
import { holdReportedServiceDealReviewText } from '~/server/services/service-deal-review-report.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const HOLD_TEXT = { comment: 'ServiceDealReview', reply: 'ServiceDealReviewReply' } as const;

export default defineModeratorEndpoint('creatorServices.reviewReport', {
  summary: 'Hide, restore, or hold for csam review one reported service review.',
  returns: '{ reviewId, action, changed, holdId? }',
  notes: [
    '`hide` takes the review off the service page and out of its counts; `restore` puts it back. Both go through the same path as the deal-page hide.',
    "`hold` opens a Pending csam hold on the review's `text` (the buyer's `comment` or the seller's `reply`), decided in the CSAM text-hold queue, and blocks that text meanwhile. It needs `reportId`: a report on this review with a CSAM or minor-sexualization reason (BAD_REQUEST otherwise).",
    "Requires the moderator app's report queues, granted by its `/reports` section (FORBIDDEN otherwise).",
    '`changed` is false when the review was already in the requested state.',
    'Resolves no report: the caller sets the report status.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: z.object({
    reviewId: z.coerce.number().int().positive().describe('The ServiceDealReview id.'),
    action: z.enum(['hide', 'restore', 'hold']),
    text: z.enum(['comment', 'reply']).optional().describe('Which text `hold` is for.'),
    reportId: z.coerce.number().int().positive().optional().describe('The report acted on.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorPageAccess(ctx.actor, '/reports')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: "Moderating a review needs the moderator app's report queues.",
      });
    const moderatorId = ctx.actor.id;
    if (input.action === 'hold') {
      if (!input.reportId || !input.text)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A hold needs the report acted on and which text to hold.',
        });
      const held = await holdReportedServiceDealReviewText({
        reviewId: input.reviewId,
        type: HOLD_TEXT[input.text],
        moderatorId,
        reportId: input.reportId,
      });
      if (held === 'refused')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a CSAM or minor-sexualization report on this review opens a CSAM hold.',
        });
      if (!held)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That review has no such text.' });
      return {
        reviewId: input.reviewId,
        action: input.action,
        changed: held.changed,
        holdId: held.holdId,
        affected: { serviceDealReviewIds: [input.reviewId], textScanHoldIds: [held.holdId] },
      };
    }

    const changed = await setServiceDealReviewHidden({
      reviewId: input.reviewId,
      moderatorId,
      hidden: input.action === 'hide',
    });
    return {
      reviewId: input.reviewId,
      action: input.action,
      changed,
      affected: { serviceDealReviewIds: [input.reviewId] },
    };
  },
});
