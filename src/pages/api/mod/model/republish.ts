import * as z from 'zod';
import { publishModelHandler } from '~/server/controllers/model.controller';
import { dbWrite } from '~/server/db/client';
import { userContentOverviewCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { bustMvCache } from '~/server/services/model-version.service';
import type { RemovedWithOwnerMeta } from '~/server/services/model-removed-with-owner.service';
import { restoreModelRemovedWithOwner } from '~/server/services/model-removed-with-owner.service';
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
    'Refused unless the model is currently unpublished as a violation, or is a model a content wipe kept in place (a draft).',
    'A model a content wipe kept goes back to the status it had, with only the versions the wipe took down; one it kept in place only loses the wipe’s record.',
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
    const record = model.meta as RemovedWithOwnerMeta | null;
    const keptInPlace = !!record?.removedWithOwner && record.statusBeforeRemoval === model.status;
    if (model.deletedAt || (model.status !== ModelStatus.UnpublishedViolation && !keptInPlace))
      throw throwBadRequestError('Model is not unpublished as a violation');

    if (record?.removedWithOwner) {
      const restored = await restoreModelRemovedWithOwner(input.modelId);
      if (!restored)
        throw throwBadRequestError('Model has no complete removal record to restore from');
      await bustMvCache(restored.versionIds, input.modelId);
      await userContentOverviewCache.refresh(restored.userId);
      await modelsSearchIndex.queueUpdate([
        { id: input.modelId, action: SearchIndexUpdateQueueAction.Update },
      ]);
      return {
        modelId: input.modelId,
        status: restored.status,
        versionIds: restored.versionIds,
        affected: { modelIds: [input.modelId] },
      };
    }

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
