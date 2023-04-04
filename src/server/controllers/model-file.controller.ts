import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput, ModelFileUpdateInput } from '~/server/schema/model-file.schema';
import {
  createFile,
  deleteFile,
  getByVersionId,
  updateFile,
} from '~/server/services/model-file.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getFilesByVersionIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getByVersionId({ modelVersionId: input.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createFileHandler = async ({ input }: { input: ModelFileCreateInput }) => {
  try {
    const file = await createFile({
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

    return file;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateFileHandler = async ({ input }: { input: ModelFileUpdateInput }) => {
  try {
    return await updateFile(input);
  } catch (error) {
    throw throwDbError(error);
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
