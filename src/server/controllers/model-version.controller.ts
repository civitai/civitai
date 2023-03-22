import { ModelStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetModelVersionSchema,
  ModelVersionUpsertInput,
} from '~/server/schema/model-version.schema';
import {
  toggleNotifyModelVersion,
  getModelVersionRunStrategies,
  getVersionById,
  upsertModelVersion,
  deleteVersionById,
  updateModelVersionById,
} from '~/server/services/model-version.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export const getModelVersionHandler = async ({ input }: { input: GetModelVersionSchema }) => {
  const { id, withFiles } = input;

  try {
    const version = await getVersionById({
      id,
      select: {
        id: true,
        name: true,
        description: true,
        baseModel: true,
        earlyAccessTimeFrame: true,
        trainedWords: true,
        epochs: true,
        steps: true,
        model: {
          select: {
            id: true,
            name: true,
            type: true,
            user: { select: { id: true } },
          },
        },
        files: withFiles
          ? {
              select: {
                name: true,
                id: true,
                sizeKB: true,
                type: true,
                metadata: true,
                pickleScanResult: true,
                pickleScanMessage: true,
                virusScanResult: true,
                scannedAt: true,
                hashes: {
                  select: {
                    type: true,
                    hash: true,
                  },
                },
              },
            }
          : false,
      },
    });
    if (!version) throw throwNotFoundError(`No version with id ${input.id}`);

    return {
      ...version,
      files: version.files as Array<
        Omit<(typeof version.files)[number], 'metadata'> & { metadata: FileMetadata }
      >,
    };
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    else throw throwDbError(e);
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

export const upsertModelVersionHandler = async ({ input }: { input: ModelVersionUpsertInput }) => {
  try {
    const version = await upsertModelVersion({ ...input });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteModelVersionHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const version = await deleteVersionById(input);
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const publishModelVersionHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const version = await updateModelVersionById({
      ...input,
      data: { status: ModelStatus.Published },
    });
    if (!version) throw throwNotFoundError(`No model with id ${input.id}`);

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};
