import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { hasModeratorPageAccess } from '~/server/services/moderator-grants';
import {
  holdReportedServiceDealReview,
  setReportedServiceDealReviewHidden,
} from '~/server/services/service-deal-review-report.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const HOLD_TEXT = { comment: 'ServiceDealReview', reply: 'ServiceDealReviewReply' } as const;

export default defineModeratorEndpoint('creatorServices.reviewReport', {
  summary: 'Hide, restore, or hold for csam review one reported service review.',
  returns: '{ reviewId, action, changed, holdId? }',
  notes: [
    '`hide` takes the review off the service page and out of its counts, and needs `reportId`: a report on this review that is not CSAM or minor-sexualization (those are held). `restore` puts it back (BAD_REQUEST while the CSAM text-hold queue holds either text). Both go through the same path as the deal-page hide.',
    "`hold` hides the whole review and opens a Pending csam hold on its `text` (the buyer's `comment` or the seller's `reply`; omitted only for a review with no text), decided in the CSAM text-hold queue, blocking that text meanwhile. It needs `reportId`: a report on this review with a CSAM or minor-sexualization reason (BAD_REQUEST otherwise).",
    "Requires the moderator app's report queues, granted by its `/reports` section (FORBIDDEN otherwise).",
    '`changed` is false when the review was already in the requested state.',
    'Resolves no report: the caller sets the report status.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: z.object({
    reviewId: z.coerce.number().int().positive().describe('The ServiceDealReview id.'),
    action: z.enum(['hide', 'restore', 'hold']),
    text: z
      .enum(['comment', 'reply'])
      .optional()
      .describe('Which text `hold` is for; omitted for a review with no text.'),
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
      if (!input.reportId)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A hold needs the report acted on.' });
      const held = await holdReportedServiceDealReview({
        reviewId: input.reviewId,
        type: input.text ? HOLD_TEXT[input.text] : null,
        moderatorId,
        reportId: input.reportId,
      });
      if (held === 'refused')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a CSAM or minor-sexualization report on this review opens a CSAM hold.',
        });
      if (held === 'pickText')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Name a text of this review to hold, or none for a review with no text.',
        });
      if (!held)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That review no longer exists.' });
      return {
        reviewId: input.reviewId,
        action: input.action,
        changed: held.changed,
        holdId: held.holdId,
        affected: {
          serviceDealReviewIds: [input.reviewId],
          textScanHoldIds: held.holdId === null ? [] : [held.holdId],
        },
      };
    }

    const changed = await setReportedServiceDealReviewHidden({
      reviewId: input.reviewId,
      moderatorId,
      hidden: input.action === 'hide',
      reportId: input.reportId,
    });
    if (changed === 'refused')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'A hide needs a report on this review; a CSAM or minor-sexualization report is held instead.',
      });
    if (changed === 'held')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'The CSAM text-hold queue holds this review: it is restored only once decided there.',
      });
    return {
      reviewId: input.reviewId,
      action: input.action,
      changed,
      affected: { serviceDealReviewIds: [input.reviewId] },
    };
  },
});
