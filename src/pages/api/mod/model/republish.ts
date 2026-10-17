import * as z from 'zod';
import { publishModelHandler } from '~/server/controllers/model.controller';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// The moderator app's site-appeal queue, approving a model appeal. The same call as the model page's
// moderator "Republish" button: tRPC's `model.publish` with every version, so the stored unpublish
// reason is dropped and the model's publish side effects run exactly as they do there.
export default defineModeratorEndpoint('model.republish', {
  summary: 'Republish a model a moderator unpublished as a violation, with all of its versions.',
  returns: '{ modelId, status }',
  notes: [
    'Refused unless the model is currently unpublished as a violation: anything else is not a moderator’s to republish.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to republish.'),
  }),
  async handler(input, ctx) {
    const model = await dbWrite.model.findUnique({
      where: { id: input.modelId },
      select: { status: true, deletedAt: true, modelVersions: { select: { id: true } } },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);
    if (model.deletedAt || model.status !== ModelStatus.UnpublishedViolation)
      throw throwBadRequestError('Model is not unpublished as a violation');

    const updated = await publishModelHandler({
      input: { id: input.modelId, versionIds: model.modelVersions.map((v) => v.id) },
      ctx: { user: ctx.actor, track: ctx.tracker },
    });
    if (!updated) throw throwNotFoundError(`No model with id ${input.modelId}`);

    return {
      modelId: input.modelId,
      status: updated.status,
      affected: { modelIds: [input.modelId] },
    };
  },
});
