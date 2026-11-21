import * as z from 'zod';
import { moderatorRemoveFromVersionShowcase } from '~/server/services/version-showcase.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('versionShowcase.remove', {
  summary: "Remove a featured community image from a model version's showcase, on both sites.",
  returns: '{ removed, modelVersionId, imageId }',
  notes: [
    'Leaves a removal marker, so the creator cannot feature the image again.',
    'Works whatever the model-version-showcase flags say.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: z.object({
    modelVersionId: z.number().int().positive(),
    imageId: z.number().int().positive(),
  }),
  async handler(input, ctx) {
    await moderatorRemoveFromVersionShowcase({ ...input, moderatorId: ctx.actor.id });
    return {
      removed: true,
      ...input,
      affected: { modelVersionIds: [input.modelVersionId], imageIds: [input.imageId] },
    };
  },
});
