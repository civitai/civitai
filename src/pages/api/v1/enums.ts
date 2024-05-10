import { ModelType } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { constants } from '~/server/common/constants';

export default async function enums(req: NextApiRequest, res: NextApiResponse) {
  return res.status(200).json({
    ModelType: Object.values(ModelType),
    ModelFileType: constants.modelFileTypes,
    BaseModel: constants.baseModels,
    BaseModelType: constants.baseModelTypes,
  });
}
