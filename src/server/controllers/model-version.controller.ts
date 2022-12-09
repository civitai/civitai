import { throwDbError } from '~/server/utils/errorHandling';
import { getModelVersionRunStrategies } from './../services/model-version.service';
import { GetByIdInput } from './../schema/base.schema';
export const getModelVersionRunStrategiesHandler = async ({
  input: { id },
}: {
  input: GetByIdInput;
}) => {
  try {
    return await getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};
