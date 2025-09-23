import { Availability } from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import type {
  AvailabilityInput,
  GetByEntityInput,
  SupportedAvailabilityResources,
} from '~/server/schema/base.schema';
import { supportedAvailabilityResources } from '~/server/schema/base.schema';
import type { SupportedClubEntities } from '~/server/schema/club.schema';
import { supportedClubEntities } from '~/server/schema/club.schema';
import {
  entityAvailabilityUpdate,
  entityRequiresClub,
  hasEntityAccess,
} from '~/server/services/common.service';
import { throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';
import { dbRead } from '../db/client';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsMetricsSearchIndex,
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

    const entityAccess = await hasEntityAccess({
      entityIds: entityId,
      entityType: entityType as SupportedAvailabilityResources,
      userId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
    });

    return entityAccess;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getEntityClubRequirementHandler = async ({
  input: { entityType, entityId },
}: {
  ctx: Context;
  input: GetByEntityInput;
}) => {
  try {
    if (!supportedClubEntities.some((e) => (e as string) === entityType)) {
      throw throwBadRequestError(`Unsupported entity type: ${entityType}`);
    }

    const clubRequirement = await entityRequiresClub({
      entityIds: entityId,
      entityType: entityType as SupportedClubEntities,
    });

    return clubRequirement;
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
    await entityAvailabilityUpdate({
      availability,
      entityIds: [entityId],
      entityType,
    });

    // Update search index:
    switch (entityType) {
      case 'ModelVersion':
        const modelVersion = await dbRead.modelVersion.findUniqueOrThrow({
          where: { id: entityId },
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
        await modelsMetricsSearchIndex.queueUpdate([
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
        await modelsMetricsSearchIndex.queueUpdate([
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
        await articlesSearchIndex.queueUpdate([
          {
            id: entityId,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          },
        ]);
        break;
      case 'Post':
        const images = await dbRead.image.findMany({ where: { postId: entityId } });
        await imagesSearchIndex.queueUpdate(
          images.map((image) => ({
            id: image.id,
            action:
              availability === Availability.Unsearchable
                ? SearchIndexUpdateQueueAction.Delete
                : SearchIndexUpdateQueueAction.Update,
          }))
        );
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
