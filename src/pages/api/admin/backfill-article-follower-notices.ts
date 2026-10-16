import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { backfillArticleFollowerNotices } from '~/server/notifications/article-follower-backfill';
import { notifications } from '~/server/notifications/client';
import type { NotificationSingleRow } from '~/server/schema/notification.schema';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * ONE-OFF. Delete this file and `src/server/notifications/article-follower-backfill.ts` once the
 * backfill has run.
 *
 * Sends the "X published a new article" notice to followers for articles the job missed.
 *
 * - GET ?token=xxx&ids=1,2,3
 *   Dry run: per article, how many followers would receive it, whether its key already exists, and
 *   what an execute would do. Sends nothing.
 * - GET ?token=xxx&ids=1,2,3&execute=true
 *   Sends. A key that already exists is skipped.
 * - &resendExisting=true
 *   Also sends to an existing key, topping up one that reached only part of its followers.
 *   Nobody receives it twice.
 * - &maxAgeDays=7 (default 7, max 30)
 *   Articles published longer ago are refused.
 */

const schema = z.object({
  ids: z
    .string()
    .transform((v) => v.split(',').map((x) => Number(x.trim())))
    .pipe(z.array(z.number().int().positive()).min(1).max(50)),
  maxAgeDays: z.coerce.number().int().min(1).max(30).default(7),
  execute: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  resendExisting: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const { ids, maxAgeDays, execute, resendExisting } = parsed.data;

  const results = await backfillArticleFollowerNotices(
    { articleIds: ids, maxAgeDays, execute, resendExisting },
    {
      readArticles: (articleIds) =>
        dbRead.article.findMany({
          where: { id: { in: articleIds } },
          select: { id: true, publishedAt: true },
        }),
      readRows: async (sql) => (await pgDbRead.query<NotificationSingleRow>(sql)).rows,
      keyExists: (key) => notifications.notificationExists({ key }),
      send: (rows) => notifications.createNotificationsBulk(rows),
      log: (result) =>
        logToAxiom(
          { type: 'info', name: 'article-follower-backfill', execute, ...result },
          'notifications'
        ).catch(() => null),
      now: () => new Date(),
    }
  );

  return res.status(200).json({ execute, maxAgeDays, results });
});
