import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { resolveMinorFlagAppeal } from '~/server/services/minor-hash.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.resolveAppeal', {
  summary: 'Rule on a pending minor-flag appeal.',
  returns: '{ resolved, rescanQueued }',
  notes: [
    'Upholding refuses if the model is no longer flagged.',
    '`minor` / `poi` rule on one label each and override `uphold` for that label.',
    'Overturning refuses, leaving the appeal open, when the model text cannot be read.',
    '`resolvedReason` is optional; when sent it must belong to the verdict (`flagAppeal`: Rejected when every flag is kept, Approved when any is lifted) and to a flag ruled on, or the request is refused.',
    '`rescanQueued` is always false and kept for compatibility: an overturn covers the text as last scanned.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    uphold: moderatorBoolean.describe('True upholds the flag, false overturns it.'),
    minor: z
      .enum(['uphold', 'overturn'])
      .optional()
      .describe('Per-label decision for the minor flag.'),
    poi: z
      .enum(['uphold', 'overturn'])
      .optional()
      .describe('Per-label decision for the real-person flag.'),
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
    const labels =
      input.minor || input.poi
        ? { ...(input.minor && { minor: input.minor }), ...(input.poi && { poi: input.poi }) }
        : undefined;
    const { rescanQueued } = await resolveMinorFlagAppeal({
      modelId: input.modelId,
      uphold: input.uphold,
      userId: ctx.actor.id,
      labels,
      resolvedReason: input.resolvedReason || undefined,
      internalNotes: input.internalNotes || undefined,
    });
    return {
      resolved: labels ? 'per-label' : input.uphold ? 'upheld' : 'overturned',
      modelId: input.modelId,
      rescanQueued,
      affected: { modelIds: [input.modelId] },
    };
  },
});
