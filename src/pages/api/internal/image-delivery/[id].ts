import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { dbRead } from '~/server/db/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ id: z.string() });
type ImageRow = {
  id: number;
  url: string;
  hideMeta: boolean;
};

const imageDeliveryRequestCounter = registerCounterWithLabels({
  name: 'image_delivery_request_total',
  help: 'Total image delivery requests by status',
  labelNames: ['status'] as const,
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success) {
    imageDeliveryRequestCounter.inc({ status: 'invalid_url' });
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid Url' });
  }

  const { id } = results.data;

  const [image] = await dbRead.$queryRaw<ImageRow[]>`
    SELECT
      id,
      url,
      "hideMeta"
    FROM "Image"
    WHERE url = ${id}
    LIMIT 1
  `;

  if (!image) {
    imageDeliveryRequestCounter.inc({ status: 'not_found' });
    return res.status(404).json({ error: 'Image not found' });
  }

  imageDeliveryRequestCounter.inc({ status: 'found' });
  res.status(200).json(image);
});
