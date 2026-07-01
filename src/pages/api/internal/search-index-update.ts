import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  comicsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  toolsSearchIndex,
  usersSearchIndex,
} from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// entityType -> the search index that owns it. Extend as spoke apps need more entities synced.
const searchIndexes = {
  article: articlesSearchIndex,
  bounty: bountiesSearchIndex,
  collection: collectionsSearchIndex,
  comic: comicsSearchIndex,
  image: imagesSearchIndex,
  model: modelsSearchIndex,
  tool: toolsSearchIndex,
  user: usersSearchIndex,
} as const;

const schema = z.object({
  entityType: z.string(),
  entityId: z.coerce.number().int().positive(),
  action: z.enum(['update', 'delete']).optional(),
});

// Internal callback so spoke apps (e.g. apps/moderator) that mutate Postgres directly can trigger a
// Meilisearch re-index without owning the search-index client. Token-guarded via WEBHOOK_TOKEN, which is
// fully trusted: the caller vouches the entity changed, so we don't verify entityId exists (queueUpdate
// tolerates unknown ids, and only trusted internal services hold the token).
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const result = schema.safeParse(req.body);
  if (!result.success)
    return res.status(400).json({ error: 'Invalid input', details: result.error.issues });

  const { entityType, entityId, action } = result.data;
  const index = searchIndexes[entityType as keyof typeof searchIndexes];
  if (!index)
    return res.status(400).json({
      error: `Unknown entityType "${entityType}". Supported: ${Object.keys(searchIndexes).join(', ')}`,
    });

  await index.queueUpdate([
    {
      id: entityId,
      action:
        action === 'delete'
          ? SearchIndexUpdateQueueAction.Delete
          : SearchIndexUpdateQueueAction.Update,
    },
  ]);

  return res.status(200).json({ ok: true, entityType, entityId });
});
