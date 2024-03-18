import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { moderateImages } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  imageIds: z.coerce.number().array().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const { imageIds } = schema.parse(req.body);
  
  await moderateImages({
    ids: imageIds,
    needsReview: false,
    reviewAction: 'delete',
    reviewType: 'blocked'
  });

  return res.status(200).json({
    images: imageIds.length,
  });
});
