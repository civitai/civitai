import * as z from 'zod';
import { deleteArticleById, restoreArticleById } from '~/server/services/article.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  action: z.enum(['restore', 'delete']),
  articleId: z.coerce.number().int().positive(),
  // The acting moderator; used for the delete audit/ownership path (bypassed by isModerator).
  userId: z.coerce.number().int().positive(),
});

// Internal callback so the moderator spoke app can run the heavy article restore/delete cascades without
// re-porting them to Kysely. Both paths re-derive nsfwLevel/ingestion, clean up image connections + S3,
// and queue the search-index update — logic that must stay single-sourced in the main app. Token-guarded
// via WEBHOOK_TOKEN (fully trusted); the caller already enforced moderator access on its side.
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const result = schema.safeParse(req.body);
  if (!result.success)
    return res.status(400).json({ error: 'Invalid input', details: result.error.issues });

  const { action, articleId, userId } = result.data;

  try {
    if (action === 'restore') await restoreArticleById({ id: articleId, userId });
    else await deleteArticleById({ id: articleId, userId, isModerator: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }

  return res.status(200).json({ ok: true, action, articleId });
});
