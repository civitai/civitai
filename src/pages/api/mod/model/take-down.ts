import * as z from 'zod';
import type { ModelMeta } from '~/server/schema/model.schema';
import { getModel, updateModelById } from '~/server/services/model.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { ModelModifier } from '~/shared/utils/prisma/enums';

// tRPC's `model.changeMode` to `TakenDown`, for Ownership and Claim reports worked in the moderator
// app. Same meta stamps (`takenDownAt` / `takenDownBy`) and tracking event, so nothing reading the
// model can tell which app took it down.
export default defineModeratorEndpoint('model.takeDown', {
  summary: 'Take a model down (ownership / claim).',
  returns: '{ modelId, mode }',
  notes: [
    'Refused when the model is already taken down.',
    'Does not touch any report: closing one is a separate decision.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to take down.'),
  }),
  async handler(input, ctx) {
    const model = await getModel({
      id: input.modelId,
      select: { id: true, meta: true, mode: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);
    if (model.mode === ModelModifier.TakenDown)
      throw throwBadRequestError('Model is already taken down');

    // Archive stamps are dropped, as `changeModelModifierHandler` does: a model is one or the other.
    const { archivedAt, archivedBy, takenDownAt, takenDownBy, ...restMeta } =
      (model.meta as ModelMeta | null) || {};
    const updated = await updateModelById({
      id: input.modelId,
      data: {
        mode: ModelModifier.TakenDown,
        meta: { ...restMeta, takenDownAt: new Date().toISOString(), takenDownBy: ctx.actor.id },
      },
    });
    await ctx.tracker.modelEvent({ type: 'Takedown', modelId: updated.id, nsfw: true });

    return { modelId: updated.id, mode: updated.mode, affected: { modelIds: [updated.id] } };
  },
});
