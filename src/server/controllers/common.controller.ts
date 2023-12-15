import { Context } from '~/server/createContext';
import { throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';
import { GetByEntityInput } from '~/server/schema/base.schema';
import { entityRequiresClub, hasEntityAccess } from '~/server/services/common.service';
import { supportedClubEntities, SupportedClubEntities } from '~/server/schema/club.schema';

export const getEntityAccessHandler = async ({
  input: { entityType, entityId },
  ctx,
}: {
  ctx: Context;
  input: GetByEntityInput;
}) => {
  try {
    if (!supportedClubEntities.some((e) => (e as string) === entityType)) {
      throw throwBadRequestError(`Unsupported entity type: ${entityType}`);
    }

    const [entityAccess] = await hasEntityAccess({
      entities: [
        {
          entityType: entityType as SupportedClubEntities,
          entityId,
        },
      ],
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

    const [clubRequirement] = await entityRequiresClub({
      entities: [
        {
          entityType: entityType as SupportedClubEntities,
          entityId,
        },
      ],
    });

    return clubRequirement;
  } catch (error) {
    throw throwDbError(error);
  }
};
