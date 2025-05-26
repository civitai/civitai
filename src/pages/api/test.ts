import { NextApiRequest, NextApiResponse } from 'next';
import inovoPayClient from '~/server/http/inovopay/inovopay.caller';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const data = await inovoPayClient.checkServiceAvailability();
  res.status(200).json(data);
});
