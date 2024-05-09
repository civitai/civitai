import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  ModelFileCreateInput,
  ModelFileUpdateInput,
  ModelFileUpsertInput,
} from '~/server/schema/model-file.schema';
import {
  createFile,
  deleteFile,
  getFilesForModelVersionCache,
  updateFile,
} from '~/server/services/model-file.service';
import { handleLogError, throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getFilesByVersionIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const data = await getFilesForModelVersionCache([input.id]);
    return data[input.id];
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileCreateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const file = await createFile({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      select: {
        id: true,
        name: true,
        modelVersion: {
          select: {
            id: true,
            status: true,
            _count: { select: { posts: { where: { publishedAt: { not: null } } } } },
          },
        },
      },
    });
    ctx.track
      .modelFile({ type: 'Create', id: file.id, modelVersionId: file.modelVersion.id })
      .catch(handleLogError);

    return file;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileUpdateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const result = await updateFile({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    ctx.track
      .modelFile({ type: 'Update', id: input.id, modelVersionId: result.modelVersionId })
      .catch(handleLogError);

    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.id !== undefined) {
      return await updateFileHandler({ input, ctx });
    } else {
      return await createFileHandler({ input, ctx });
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteFileHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const modelVersionId = await deleteFile({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    if (!modelVersionId) throw throwNotFoundError(`No file with id ${input.id}`);

    ctx.track.modelFile({ type: 'Delete', id: input.id, modelVersionId }).catch(handleLogError);

    return { modelVersionId };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
