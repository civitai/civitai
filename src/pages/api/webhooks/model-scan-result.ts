import { NextApiRequest, NextApiResponse } from 'next';
import z from 'zod';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  user_declared: z.object({
    content: z.object({
      id: z.number(),
      name: z.string(),
      POI: z.boolean(),
      NSFW: z.boolean(),
      minor: z.boolean(),
      triggerwords: z.string().array(),
      image_urls: z.string().array(),
      links: z.string().array(),
    }),
  }),
  status: z.enum(['Success', 'Failure']),
  flags: z.object({
    POI_flag: z.boolean(),
    NSFW_flag: z.boolean(),
    minor_flag: z.boolean(),
    triggerwords_flag: z.boolean(),
  }),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const result = schema.safeParse(req.body);
  if (!result.success)
    return res.status(400).json({ error: 'Invalid Request', details: result.error.format() });

  try {
    const data = result.data;
    switch (data.status) {
      case 'Success':
        // Check scan results and handle accordingly
        await dbWrite.model.update({
          where: { id: data.user_declared.content.id },
          data: {
            scannedAt: new Date(),
            rawScanResult: data.flags,
          },
        });
        return;
      case 'Failure':
        await dbWrite.model.update({
          where: { id: data.user_declared.content.id },
          data: { rawScanResult: data.flags },
        });
        return;
      default:
        return res.status(400).json({ error: 'Unhandled status' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error', details: error });
  }
});
