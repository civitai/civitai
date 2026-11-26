import * as z from 'zod';
import { publishModelHandler } from '~/server/controllers/model.controller';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { ModelStatus } from '~/shared/utils/prisma/enums';

type UnpublishStamp = { unpublishedAt?: string } | null;

// The moderator app's site-appeal queue, approving a model appeal. tRPC's `model.publish` as a
// moderator, so the stored unpublish reason is dropped and the publish side effects run as they do
// from the model page.
export default defineModeratorEndpoint('model.republish', {
  summary:
    'Republish a model unpublished as a violation, with the versions that came down with it.',
  returns: '{ modelId, status, versionIds }',
  notes: [
    'Refused unless the model is currently unpublished as a violation.',
    'Only versions the same take-down unpublished go back up: never drafts, nor a version removed on its own.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to republish.'),
  }),
  async handler(input, ctx) {
    const model = await dbWrite.model.findUnique({
      where: { id: input.modelId },
      select: {
        status: true,
        deletedAt: true,
        meta: true,
        modelVersions: {
          // A moderator take-down marks versions UnpublishedViolation; a ban marks them Unpublished.
          where: { status: { in: [ModelStatus.UnpublishedViolation, ModelStatus.Unpublished] } },
          select: { id: true, status: true, meta: true },
        },
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);
    if (model.deletedAt || model.status !== ModelStatus.UnpublishedViolation)
      throw throwBadRequestError('Model is not unpublished as a violation');

    // A take-down stamps the model and each version it moved with one `unpublishedAt`, which tells
    // this take-down's versions from ones removed on their own or by their owner. An unstamped model
    // falls back to its violation-unpublished versions.
    const takenDownAt = (model.meta as UnpublishStamp)?.unpublishedAt;
    const versionIds = model.modelVersions
      .filter((v) =>
        takenDownAt
          ? (v.meta as UnpublishStamp)?.unpublishedAt === takenDownAt
          : v.status === ModelStatus.UnpublishedViolation
      )
      .map((v) => v.id);
    if (!versionIds.length)
      throw throwBadRequestError(
        'No version carries this take-down’s stamp; choose the versions from the model page.'
      );

    const updated = await publishModelHandler({
      input: { id: input.modelId, versionIds },
      ctx: { user: ctx.actor, track: ctx.tracker },
    });
    if (!updated) throw throwNotFoundError(`No model with id ${input.modelId}`);

    return {
      modelId: input.modelId,
      status: updated.status,
      versionIds,
      affected: { modelIds: [input.modelId] },
    };
  },
});
