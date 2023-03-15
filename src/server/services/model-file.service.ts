import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import { prepareFile } from '~/utils/file-helpers';

export const getByVersionId = ({ modelVersionId }: { modelVersionId: number }) => {
  return dbRead.modelFile.findMany({ where: { modelVersionId } });
};

export const createFile = (data: ModelFileCreateInput) => {
  const file = prepareFile(data);

  return dbWrite.modelFile.create({
    data: {
      modelVersionId: data.modelVersionId,
      ...file,
    },
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
