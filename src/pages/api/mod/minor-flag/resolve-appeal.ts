import * as z from 'zod';
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
    '`rescanQueued` is true when the text changed while the appeal was pending.',
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
    });
    return {
      resolved: labels ? 'per-label' : input.uphold ? 'upheld' : 'overturned',
      modelId: input.modelId,
      rescanQueued,
      affected: { modelIds: [input.modelId] },
    };
  },
});
