import * as z from 'zod';
import { unpublishReasons, type UnpublishReason } from '~/server/common/moderation-helpers';
import { dbRead } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { unpublishModelById } from '~/server/services/model.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const REASONS = Object.keys(unpublishReasons) as [UnpublishReason, ...UnpublishReason[]];

// The moderator app's reports panel, so a reported model can be taken down from the report rather than
// from a second tab. Same service, tracking and cache refresh as tRPC's `model.unpublish` for a
// moderator — the owner notification and the stored reason are written by `unpublishModelById`.
export default defineModeratorEndpoint('model.unpublish', {
  summary: 'Unpublish a model as a violation, notifying the owner with the given reason.',
  returns: '{ modelId }',
  notes: [
    '`customMessage` is required when `reason` is `other`: it is then the only explanation the owner sees.',
    'Does not touch any report: closing one is a separate decision.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to unpublish.'),
    reason: z.enum(REASONS).describe('One of `unpublishReasons`; picks the owner notification.'),
    customMessage: z.string().trim().max(1000).optional().describe('Extra text for the owner.'),
  }),
  async handler(input, ctx) {
    // In the handler rather than a `.refine()`: that returns a ZodEffects, and `specToDoc` needs a
    // ZodObject to project the params for the docs page (see `schema/moderator/comment.ts`).
    if (input.reason === 'other' && !input.customMessage)
      throw throwBadRequestError('A message is required when the reason is "other".');

    const model = await dbRead.model.findUnique({
      where: { id: input.modelId },
      select: { nsfw: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);

    await unpublishModelById({
      id: input.modelId,
      reason: input.reason,
      customMessage: input.customMessage || undefined,
      userId: ctx.actor.id,
      isModerator: true,
    });
    await ctx.tracker.modelEvent({ type: 'Unpublish', modelId: input.modelId, nsfw: model.nsfw });
    await dataForModelsCache.refresh(input.modelId);

    return {
      modelId: input.modelId,
      affected: { modelIds: [input.modelId] },
    };
  },
});
