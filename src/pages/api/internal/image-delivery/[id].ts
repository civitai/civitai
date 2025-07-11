import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';

import { dbRead } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ id: z.string() });
type ImageRow = {
  id: number;
  url: string;
  hideMeta: boolean;
};

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: `Invalid id: ${results.error.flatten().fieldErrors.id}` });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing image id' });

  const [image] = await dbRead.$queryRaw<ImageRow[]>`
    SELECT
      id,
      url,
      "hideMeta"
    FROM "Image"
    WHERE url = ${id}
    LIMIT 1
  `;
  if (!image) return res.status(404).json({ error: 'Image not found' });
  res.status(200).json(image);
});
