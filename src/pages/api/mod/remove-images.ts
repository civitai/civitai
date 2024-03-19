import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { moderateImages } from '~/server/services/image.service';
import { WebhookEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  imageIds: z.array(z.number()),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds } = schema.parse(req.body);

    await moderateImages({
      ids: imageIds,
      needsReview: undefined,
      reviewAction: 'delete',
      reviewType: 'blocked',
    });

    return res.status(200).json({
      images: imageIds.length,
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
