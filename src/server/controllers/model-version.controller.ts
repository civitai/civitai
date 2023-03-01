import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
import {
  toggleNotifyModelVersion,
  getModelVersionRunStrategies,
  getVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export const toggleNotifyEarlyAccessHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const version = await getVersionById({ ...input, select: { id: true } });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    return toggleNotifyModelVersion({ ...input, userId });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const upsertModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: ModelVersionUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const version = await upsertModelVersion({ ...input });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
