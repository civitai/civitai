import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { resolveLockReviewAppeal } from '~/server/services/lock-review.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('model.resolveLockReview', {
  summary: "Rule on an owner's pending request to review a model's locked settings.",
  returns: '{ modelId, approved, unlocked }',
  notes: [
    'Approving unlocks only the settings the owner named that are still locked; their values are left as they are.',
    "Approving refuses while the owner's account is under an evidence hold, or once the model is flagged as a real person or a minor. Rejecting is always allowed.",
    '`resolvedReason`, when sent, must be a `lockReview` reason for the verdict.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    appealId: z.coerce
      .number()
      .int()
      .positive()
      .describe('The request ruled on, as the queue listed it.'),
    modelId: z.coerce.number().int().positive().describe('The model whose request to rule on.'),
    approve: moderatorBoolean.describe('True unlocks the named settings, false keeps them locked.'),
    resolvedReason: z
      .string()
      .trim()
      .optional()
      .describe('A reason slug from @civitai/shared/resolution-reasons for this verdict.'),
    internalNotes: z
      .string()
      .trim()
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .optional()
      .describe('Moderator-only note. Never shown to the user.'),
  }),
  async handler(input, ctx) {
    const { unlocked } = await resolveLockReviewAppeal({
      appealId: input.appealId,
      modelId: input.modelId,
      approve: input.approve,
      userId: ctx.actor.id,
      resolvedReason: input.resolvedReason || undefined,
      internalNotes: input.internalNotes || undefined,
    });
    return {
      modelId: input.modelId,
      approved: input.approve,
      unlocked,
      affected: { modelIds: [input.modelId] },
    };
  },
});
