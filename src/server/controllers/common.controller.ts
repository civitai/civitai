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

    const entityAccess = await hasEntityAccess({
      entityIds: entityId,
      entityType: entityType as SupportedClubEntities,
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
