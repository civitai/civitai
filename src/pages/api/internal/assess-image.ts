import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { env } from '~/env/server';
import { addCorsHeaders, TokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  url: z.string(),
});
const resultCache = new Map<string, any>();

export default TokenSecuredEndpoint(
  env.HIVE_VISUAL_TOKEN?.slice(0, 5) ?? 'dummy',
  async function (req: NextApiRequest, res: NextApiResponse) {
    if (!env.HIVE_VISUAL_TOKEN) return res.status(500).json({ error: 'Missing HIVE_VISUAL_TOKEN' });

    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { url } = schema.parse(req.body);
    if (resultCache.has(url)) return res.status(200).json(resultCache.get(url));

    try {
      const response = await fetch('https://api.thehive.ai/api/v2/task/sync', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `token ${env.HIVE_VISUAL_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ url }),
      });

      if (!response.ok) throw new Error('Network response was not ok');

      const data = await response.json();
      resultCache.set(url, data);
      return res.status(200).json(data);
    } catch (error) {
      // Handle errors
      return res.status(500).json({ error: 'Error fetching image assessment' });
    }
  }
);
