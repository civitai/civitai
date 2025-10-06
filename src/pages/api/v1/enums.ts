import { ModelType } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { constants } from '~/server/common/constants';
import { activeBaseModels, baseModels } from '~/shared/constants/base-model.constants';

export default async function enums(req: NextApiRequest, res: NextApiResponse) {
  return res.status(200).json({
    ModelType: Object.values(ModelType),
    ModelFileType: constants.modelFileTypes,
    ActiveBaseModel: activeBaseModels,
    BaseModel: baseModels,
    BaseModelType: constants.baseModelTypes,
  });
}
