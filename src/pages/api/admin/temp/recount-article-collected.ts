import * as z from 'zod';
import { pgDbRead } from '~/server/db/pgDb';
import { articleMetrics } from '~/server/metrics';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Queue saved articles for the article metric job, which recounts `collectedCount` for every
 * queued id as people other than the author who saved it, each once.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * The job recounts an article only when it gets a save or an unsave, so an article that gets
 * neither keeps the old per-item total: one account that saved it into N collections still counts
 * N. Queueing through the job keeps one definition of the count, and the job already busts the
 * article stat cache and queues the search index for what it writes.
 *
 * Usage, repeated with `after=<nextAfter>` until `nextAfter` is null:
 *   POST /api/admin/temp/recount-article-collected?token=$WEBHOOK_TOKEN&dryRun=false&after=0
 *
 * Params (query):
 *   dryRun - default true. Report the page of ids, queue nothing.
 *   after  - default 0. Article id cursor, exclusive.
 *   limit  - default 5000. Ids per page.
 *
 * Selects articles with a collection item, or with a non-zero count and no items left.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20000).default(5000),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, after, limit } = parsed.data;

  const { rows } = await pgDbRead.query<{ id: number }>(
    `SELECT a.id
     FROM "Article" a
     WHERE a.id > $1
       AND (
         EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."articleId" = a.id)
         OR EXISTS (
           SELECT 1 FROM "ArticleMetric" am
           WHERE am."articleId" = a.id AND am.timeframe = 'AllTime' AND am."collectedCount" <> 0
         )
       )
     ORDER BY a.id
     LIMIT $2`,
    [after, limit]
  );
  const ids = rows.map((r) => r.id);

  if (!dryRun && ids.length) await articleMetrics.queueUpdate(ids);

  return res.status(200).json({
    dryRun,
    count: ids.length,
    firstId: ids[0] ?? null,
    lastId: ids.at(-1) ?? null,
    nextAfter: ids.length === limit ? ids.at(-1) : null,
  });
});
