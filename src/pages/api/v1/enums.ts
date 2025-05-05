import { ModelType } from '~/shared/utils/prisma/enums';
import { NextApiRequest, NextApiResponse } from 'next';
import { activeBaseModels, constants } from '~/server/common/constants';

export default async function enums(req: NextApiRequest, res: NextApiResponse) {
  return res.status(200).json({
    ModelType: Object.values(ModelType),
    ModelFileType: constants.modelFileTypes,
    ActiveBaseModel: activeBaseModels,
    BaseModel: constants.baseModels,
    BaseModelType: constants.baseModelTypes,
  });
}
