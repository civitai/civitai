import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { clavata } from '~/server/integrations/clavata';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  imageUrl: z.string().optional(),
  policyId: z.string().optional(),
  image: z.string().optional(),
});

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '17mb',
    },
  },
};

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const { imageUrl, image, policyId } = schema.parse(req.body);

    if (!imageUrl && !image) {
      return res.status(400).json({
        error: 'Either imageUrl or image must be provided',
      });
    }

    try {
      const data = image || imageUrl;
      const result = await clavata!.runJobAsync(data as string, policyId);
      return res.status(200).json(result.tags);
    } catch (e) {
      console.error('Error processing image with Clavata:', e);
      return res.status(500).json({
        error: (e as Error).message,
      });
    }
  },
  ['POST']
);
