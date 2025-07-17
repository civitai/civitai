import type { NextApiRequest, NextApiResponse } from 'next';
import { getRegion, isRegionBlocked } from '~/server/utils/region-blocking';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { countryCode, fullLocationCode } = getRegion(req);
  const blocked = isRegionBlocked(countryCode === 'US' ? fullLocationCode : countryCode);

  res.status(200).json({
    country: countryCode || 'unknown',
    fullLocationCode,
    blocked,
    message: blocked ? 'Access restricted in your region' : 'Access allowed from your region',
  });
}
