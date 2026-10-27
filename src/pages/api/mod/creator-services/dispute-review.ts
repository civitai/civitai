import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import {
  createServiceDisputeReview,
  DISPUTE_REVIEW_CLASSES,
  DISPUTE_REVIEW_MODES,
} from '~/server/services/creator-service-dispute-review.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const MAX_EVIDENCE_BYTES = 64 * 1024;

export default defineModeratorEndpoint('creatorServices.disputeReview', {
  summary: 'Record a review of a Disputed Creator Services deal: its class and proposed ruling.',
  returns: '{ id, createdAt }',
  notes: [
    'Requires the moderator app permission `creatorServices.reviewDispute`. It moves no Buzz and settles nothing, whatever `mode` says.',
    '`proposal` null means the review escalates to a human. The latest review is shown on the dispute card, and filled with the human ruling when the deal is resolved.',
    'A deal that is not Disputed answers CONFLICT. A moderator who is its buyer or seller answers FORBIDDEN.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  // Up to 64 KB, and kept whole on the review row itself.
  auditExclude: ['evidence'],
  input: z.object({
    dealId: z.coerce.number().int().positive(),
    class: z.enum(DISPUTE_REVIEW_CLASSES),
    proposal: z.enum(['Refund', 'Release']).nullable(),
    confidence: z.number().min(0).max(1).nullable().default(null),
    rationale: z.string().trim().min(1).max(4000).describe('Shown to moderators.'),
    evidence: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= MAX_EVIDENCE_BYTES, {
        message: `At most ${MAX_EVIDENCE_BYTES} bytes of evidence.`,
      })
      .describe('The bundle the review read, as JSON.'),
    agentVersion: z.string().trim().min(1).max(100),
    mode: z.enum(DISPUTE_REVIEW_MODES),
  }),
  async handler(input, { actor }) {
    if (!(await hasModeratorGrant(actor, 'creatorServices.reviewDispute')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Writing a dispute review needs the "creatorServices.reviewDispute" moderator permission.',
      });
    const review = await createServiceDisputeReview({ ...input, reviewerId: actor.id });
    return { ...review, affected: { serviceDealIds: [input.dealId] } };
  },
});
