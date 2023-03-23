import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileUpsertInput } from '~/server/schema/model-file.schema';
import { upsertFile, deleteFile, getByVersionId } from '~/server/services/model-file.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getFilesByVersionIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getByVersionId({ modelVersionId: input.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertFileHandler = async ({ input }: { input: ModelFileUpsertInput }) => {
  try {
    const file = await upsertFile({
      ...input,
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
    if (!file) throw throwNotFoundError(`No file with id ${input.id}`);

    return file;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteFileHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const deleted = await deleteFile(input);
    if (!deleted) throw throwNotFoundError(`No file with id ${input.id}`);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
