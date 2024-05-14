import { NextApiRequest, NextApiResponse } from 'next';
import { ExternalMetaSchema } from '~/server/schema/image.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload: ExternalMetaSchema = {
    source: {
      name: 'Bretty',
      homepage: 'https://leonardo.ai',
    },
    details: {
      stuff: 1,
      things: 'morethings',
      extra: 'extragood1',
      coolness: true,
    },
    createUrl: 'http://idkhowtocreate.com',
    referenceUrl: 'https://thisisareference.com',
  };

  return res.status(200).json(payload);
});
