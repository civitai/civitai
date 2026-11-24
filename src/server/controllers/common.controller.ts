import { Availability } from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import type {
  AvailabilityInput,
  GetByEntityInput,
  SupportedAvailabilityResources,
} from '~/server/schema/base.schema';
import { supportedAvailabilityResources } from '~/server/schema/base.schema';
import { entityAvailabilityUpdate, hasEntityAccess } from '~/server/services/common.service';
import { queueLeftPrivateForKnights } from '~/server/services/knights/sources';
import { throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';
import { withSpan } from '~/server/utils/otel-helpers';
import { dbRead, dbWrite } from '../db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  imagesMetricsSearchIndex,
  modelsSearchIndex,
} from '../search-index';

export const getEntityAccessHandler = async ({
  input: { entityType, entityId },
  ctx,
}: {
  ctx: Context;
  input: GetByEntityInput;
}) => {
  try {
    if (!supportedAvailabilityResources.some((e) => (e as string) === entityType)) {
      throw throwBadRequestError(`Unsupported entity type: ${entityType}`);
    }

    const entityAccess = await withSpan('common:getEntityAccess', () =>
      hasEntityAccess({
        entityIds: entityId,
        entityType: entityType as SupportedAvailabilityResources,
        userId: ctx.user?.id,
        isModerator: !!ctx.user?.isModerator,
      })
    );

    return entityAccess;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateEntityAvailabilityHandler = async ({
  input: { availability, entityId, entityType },
}: {
  ctx: Context;
  input: AvailabilityInput;
}) => {
  try {
    // A post, model or version leaving Private is offered to the Knights, as moveImagesToPost and publishPrivateModel
    // do. Read before the write, which overwrites the old availability; from the primary so a lagging replica cannot
    // hide Private.
    const leavesPrivate =
      availability !== Availability.Private &&
      (await priorAvailability(entityType, entityId)) === Availability.Private;

    await entityAvailabilityUpdate({
      availability,
      entityIds: [entityId],
      entityType,
    });
    if (leavesPrivate) await offerLeftPrivateToKnights(entityType, entityId);

    // Update search index:
    switch (entityType) {
      case 'ModelVersion':
        const findArgs = { where: { id: entityId } } as const;
        const modelVersion = await dbRead.modelVersion.findUniqueOrThrow(findArgs).catch(() => {
          dbReadFallbackCounter.inc({
            entity: 'modelVersion',
            caller: 'updateEntityAvailabilityHandler',
          });
          return dbWrite.modelVersion.findUniqueOrThrow(findArgs);
        });

        await modelsSearchIndex.queueUpdate([
          {
            id: modelVersion.modelId,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          },
        ]);
        break;
      case 'Model':
        await modelsSearchIndex.queueUpdate([
          {
            id: entityId,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          },
        ]);
        break;
      case 'Article':
        await articlesSearchIndex.queueUpdate(
          [
            {
              id: entityId,
              action:
                availability === Availability.Unsearchable || availability === Availability.Private
                  ? SearchIndexUpdateQueueAction.Delete
                  : SearchIndexUpdateQueueAction.Update,
            },
          ],
          { reason: 'availability' }
        );
        break;
      case 'Post':
        const images = await dbRead.image.findMany({
          where: { postId: entityId },
          select: { id: true },
        });
        // TODO do we need this here?
        await imagesMetricsSearchIndex.queueUpdate(
          images.map((image) => ({
            id: image.id,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          }))
        );
        break;
      case 'Collection':
        await collectionsSearchIndex.queueUpdate([
          {
            id: entityId,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          },
        ]);
        break;
      case 'Bounty':
        await bountiesSearchIndex.queueUpdate([
          {
            id: entityId,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          },
        ]);
        break;
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

/** The stored availability, from the primary, of an entity whose leaving Private offers images to the Knights. */
async function priorAvailability(
  entityType: SupportedAvailabilityResources,
  id: number
): Promise<Availability | undefined> {
  const select = { availability: true } as const;
  if (entityType === 'Post')
    return (await dbWrite.post.findUnique({ where: { id }, select }))?.availability;
  if (entityType === 'Model')
    return (await dbWrite.model.findUnique({ where: { id }, select }))?.availability;
  if (entityType === 'ModelVersion')
    return (await dbWrite.modelVersion.findUnique({ where: { id }, select }))?.availability;
  return undefined;
}

/** Never waits on the Knights: the offer runs after the response, and logs its own failures. */
async function offerLeftPrivateToKnights(entityType: SupportedAvailabilityResources, id: number) {
  if (entityType === 'Post') return void queueLeftPrivateForKnights({ postIds: [id] });
  if (entityType === 'ModelVersion')
    return void queueLeftPrivateForKnights({ modelVersionIds: [id] });
  if (entityType !== 'Model') return;
  // The model's trigger carries a flip to Public onto its versions; the sampler still checks each version's own state.
  const versions = await dbWrite.modelVersion.findMany({
    where: { modelId: id },
    select: { id: true },
  });
  if (versions.length > 0)
    void queueLeftPrivateForKnights({ modelVersionIds: versions.map((v) => v.id) });
}
