import * as z from 'zod';
import { evictHomeBlocksForImages } from '~/server/services/home-block-cache.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  imageIds: z.array(z.coerce.number().int().positive()).min(1).max(1000),
});

// Lets a spoke app that hides images directly (apps/moderator) refresh the home blocks showing them,
// without owning the home-block cache. Call it after the hiding write has committed.
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const result = schema.safeParse(req.body);
  if (!result.success)
    return res.status(400).json({ error: 'Invalid input', details: result.error.issues });

  const imageIds = [...new Set(result.data.imageIds)];
  await evictHomeBlocksForImages({ imageIds });
  return res.status(200).json({ ok: true, count: imageIds.length });
});
