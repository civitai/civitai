import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput, ModelFileUpdateInput } from '~/server/schema/model-file.schema';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { prepareFile } from '~/utils/file-helpers';

export const getByVersionId = ({ modelVersionId }: { modelVersionId: number }) => {
  return dbRead.modelFile.findMany({ where: { modelVersionId } });
};

export const createFile = <TSelect extends Prisma.ModelFileSelect>({
  select,
  ...data
}: ModelFileCreateInput & { select: TSelect }) => {
  const file = prepareFile(data);

  return dbWrite.modelFile.create({
    data: { ...file, modelVersionId: data.modelVersionId },
    select,
  });
};

export const updateFile = async ({ id, metadata, ...inputData }: ModelFileUpdateInput) => {
  const modelFile = await dbRead.modelFile.findUnique({
    where: { id },
    select: { id: true, metadata: true },
  });
  if (!modelFile) throw throwNotFoundError();
  return dbWrite.modelFile.update({
    where: { id },
    data: {
      ...inputData,
      metadata: metadata
        ? { ...(modelFile.metadata as Prisma.JsonObject), ...metadata }
        : undefined,
    },
    select: { id: true },
  });
};

// only pass data that can change (ie. modelFile.type)
// export const updateFile = async (data) => {};

export const deleteFile = ({ id }: GetByIdInput) => {
  return dbWrite.modelFile.delete({ where: { id } });
};

export const batchDeleteFiles = ({ ids }: { ids: number[] }) => {
  return dbWrite.modelFile.deleteMany({ where: { id: { in: ids } } });
};
