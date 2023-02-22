import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileUpsertInput } from '~/server/schema/model-file.schema';
import { prepareFile } from '~/utils/file-helpers';

export const getByVersionId = ({ modelVersionId }: { modelVersionId: number }) => {
  return dbRead.modelFile.findMany({ where: { modelVersionId } });
};

export const upsertFile = (data: ModelFileUpsertInput) => {
  const file = prepareFile(data);

  if (!file.id)
    return dbWrite.modelFile.create({ data: { ...file, modelVersionId: data.modelVersionId } });

  return dbWrite.modelFile.update({
    where: { id: file.id },
    data: {
      ...file,
      modelVersionId: data.modelVersionId,
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
