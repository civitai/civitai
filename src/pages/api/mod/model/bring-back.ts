import * as z from 'zod';
import { getModel, updateModelById } from '~/server/services/model.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { ModelModifier } from '~/shared/utils/prisma/enums';

// The undo for `model.takeDown`: tRPC's `model.changeMode` back to no mode, which the model page's
// moderator menu offers as "Bring Back". Same meta handling — the archive and take-down stamps are
// all dropped — so nothing reading the model can tell which app brought it back.
export default defineModeratorEndpoint('model.bringBack', {
  summary: 'Bring back a taken-down model.',
  returns: '{ modelId, mode }',
  notes: [
    'Refused unless the model is currently taken down: an archived model is its owner’s call.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to bring back.'),
  }),
  async handler(input) {
    const model = await getModel({ id: input.modelId, select: { id: true, mode: true } });
    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);
    const assertDown = (mode: ModelModifier | null | undefined) => {
      if (mode !== ModelModifier.TakenDown) throw throwBadRequestError('Model is not taken down');
    };
    assertDown(model.mode);

    const updated = await updateModelById({
      id: input.modelId,
      data: { mode: null },
      meta: (stored, row) => {
        assertDown(row?.mode);
        const { archivedAt, archivedBy, takenDownAt, takenDownBy, ...restMeta } = stored || {};
        return restMeta;
      },
    });

    return { modelId: updated.id, mode: updated.mode, affected: { modelIds: [updated.id] } };
  },
});
