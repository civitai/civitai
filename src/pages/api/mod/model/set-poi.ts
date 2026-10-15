import * as z from 'zod';
import { setModelPoi } from '~/server/services/model.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

// The model edit form's POI checkbox, for the moderator app's reports panel — so flagging a model as
// depicting a real person no longer means edit page → save → reload. The service owns the
// restrictions a POI model carries and their propagation to its images.
export default defineModeratorEndpoint('model.setPoi', {
  summary: 'Set or lift a model as depicting a real person (POI).',
  returns: '{ modelId, poi }',
  notes: [
    'Setting it also makes the model SFW-only and not NSFW, and locks those fields against the creator.',
    "Lifting it leaves SFW-only as it is, records the moderator's ruling for the text scan, and closes the owner's flag appeal.",
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to change.'),
    poi: z.boolean().describe('True to flag the model as depicting a real person.'),
  }),
  async handler(input, ctx) {
    await setModelPoi({
      id: input.modelId,
      poi: input.poi,
      userId: ctx.actor.id,
      tracker: ctx.tracker,
      isModerator: true,
    });
    return {
      modelId: input.modelId,
      poi: input.poi,
      affected: { modelIds: [input.modelId] },
    };
  },
});
