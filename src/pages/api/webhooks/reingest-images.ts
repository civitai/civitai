import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { ingestImageBulk } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  imageIds: z.array(z.number()).min(1),
  lowPriority: z.boolean().default(true),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { imageIds, lowPriority } = schema.parse(req.body);

  const images = await dbWrite.$queryRaw<IngestImageInput[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt
    FROM "Image"
    WHERE id IN (${Prisma.join(imageIds)})
  `;

  if (!images.length) {
    return res.status(404).json({ error: 'No images found for the provided IDs' });
  }

  const foundIds = images.map((i) => i.id);

  const success = await ingestImageBulk({ images, lowPriority });

  res.status(200).json({ success, count: images.length, imageIds: foundIds });
});
