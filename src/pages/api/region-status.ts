import type { NextApiRequest, NextApiResponse } from 'next';
import { getRegion, isRegionBlocked } from '~/server/utils/region-blocking';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const region = getRegion(req);
  const blocked = isRegionBlocked(region);

  res.status(200).json({
    country: region.countryCode || 'unknown',
    fullLocationCode: region.fullLocationCode || 'unknown',
    blocked,
    message: blocked ? 'Access restricted in your region' : 'Access allowed from your region',
  });
}
