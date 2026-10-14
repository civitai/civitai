import * as z from 'zod';
import { setModelSfwOnly } from '~/server/services/model.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

// tRPC's `model.setSfwOnly`, for the moderator app's reports panel. The service owns the propagation
// to the model's images and refuses to unset it on a model flagged as depicting a minor.
export default defineModeratorEndpoint('model.setSfwOnly', {
  summary: 'Set or unset a model as SFW-only.',
  returns: '{ modelId, sfwOnly }',
  notes: ['A model flagged as depicting a minor is always SFW-only; unsetting it is refused.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to change.'),
    sfwOnly: z.boolean().describe('True to restrict the model to SFW.'),
  }),
  async handler(input, ctx) {
    await setModelSfwOnly({
      id: input.modelId,
      sfwOnly: input.sfwOnly,
      userId: ctx.actor.id,
      tracker: ctx.tracker,
      isModerator: true,
    });
    return {
      modelId: input.modelId,
      sfwOnly: input.sfwOnly,
      affected: { modelIds: [input.modelId] },
    };
  },
});
