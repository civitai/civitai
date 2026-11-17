import type { NextApiRequest, NextApiResponse } from 'next';
import {
  getRegion,
  isRegionBlocked,
  isRegionPendingBlock,
  getDaysUntilRegionBlock,
  getRegionBlockDate,
} from '~/server/utils/region-blocking';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const region = getRegion(req);
  const blocked = isRegionBlocked(region);
  const pendingBlock = isRegionPendingBlock(region);
  const daysUntilBlock = getDaysUntilRegionBlock(region);
  const blockDate = getRegionBlockDate(region);

  let message: string;
  if (blocked) {
    message = 'Access restricted in your region';
  } else if (pendingBlock && daysUntilBlock) {
    message = `Access will be restricted in your region in ${daysUntilBlock} day${
      daysUntilBlock !== 1 ? 's' : ''
    }`;
  } else {
    message = 'Access allowed from your region';
  }

  res.status(200).json({
    country: region.countryCode || 'unknown',
    fullLocationCode: region.fullLocationCode || 'unknown',
    blocked,
    pendingBlock,
    daysUntilBlock,
    blockDate: blockDate?.toISOString(),
    message,
  });
}
