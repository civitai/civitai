import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { registerCounterWithLabels } from '~/server/prom/client';
import { getCachedImageDeliveryMetadata } from '~/server/services/image-delivery.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ id: z.string() });

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

  // `id` is the image url (the raw query keys on `WHERE url = $1`). Read-through Redis cache
  // fronts the near-immutable url -> {id, url, hideMeta} lookup; fails open to the DB.
  const image = await getCachedImageDeliveryMetadata(id);

  if (!image) {
    imageDeliveryRequestCounter.inc({ status: 'not_found' });
    return res.status(404).json({ error: 'Image not found' });
  }

  imageDeliveryRequestCounter.inc({ status: 'found' });
  res.status(200).json(image);
});
