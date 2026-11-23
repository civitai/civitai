import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  addCreationBlockedTags,
  getCreationBlockedTags,
  removeCreationBlockedTags,
  setCreationBlockedTags,
} from '~/server/services/system-cache';

/**
 * Admin endpoint to manage the list of tags that creators cannot apply to
 * their own models. Backed by sysRedis key `system:creation-blocked-tags`
 * stored as a JSON array of `{ id, name }` objects.
 *
 * GET    /api/admin/creation-blocked-tags?token=<WEBHOOK_TOKEN>
 *        → { tags: { id: number, name: string }[] }
 *
 * POST   /api/admin/creation-blocked-tags?token=<WEBHOOK_TOKEN>
 *        body: { action: 'set' | 'add' | 'remove', tagIds: number[] }
 *        → { tags } after the write. Names are resolved from the Tag table.
 */

const bodySchema = z.object({
  action: z.enum(['set', 'add', 'remove']),
  tagIds: z.array(z.number().int().positive()),
});

export default WebhookEndpoint(async (req, res) => {
  if (req.method === 'GET') {
    const tags = await getCreationBlockedTags();
    return res.status(200).json({ tags });
  }

  if (req.method === 'POST') {
    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid body', issues: parse.error.issues });
    }
    const { action, tagIds } = parse.data;
    let tags;
    switch (action) {
      case 'set':
        tags = await setCreationBlockedTags(tagIds);
        break;
      case 'add':
        tags = await addCreationBlockedTags(tagIds);
        break;
      case 'remove':
        tags = await removeCreationBlockedTags(tagIds);
        break;
    }
    return res.status(200).json({ tags });
  }

  return res.status(405).json({ error: 'Method not allowed' });
});
