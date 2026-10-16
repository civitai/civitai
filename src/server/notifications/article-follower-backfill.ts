import {
  articleNotifications,
  NEW_ARTICLE_FROM_FOLLOWING_TYPE,
  newArticleFromFollowingQuery,
} from '~/server/notifications/article.notifications';
import type {
  NotificationPendingRow,
  NotificationSingleRow,
} from '~/server/schema/notification.schema';

/**
 * One-off: sends `new-article-from-following` for articles the job missed. Remove after the run
 * (see `src/pages/api/admin/backfill-article-follower-notices.ts`).
 *
 * Recipients come from the processor's own query, so the backfill applies exactly the live rules,
 * and every row carries the processor's own key, which the notifications worker never delivers to
 * the same user twice.
 */

export type BackfillArticleOutcome =
  | 'would-send'
  | 'sent'
  | 'skipped-existing'
  | 'not-found'
  | 'too-old'
  | 'no-recipients';

export type BackfillArticleResult = {
  articleId: number;
  key: string;
  recipients: number;
  keyExists: boolean;
  outcome: BackfillArticleOutcome;
};

export type BackfillDeps = {
  readArticles: (ids: number[]) => Promise<{ id: number; publishedAt: Date | null }[]>;
  readRows: (sql: string) => Promise<NotificationSingleRow[]>;
  keyExists: (key: string) => Promise<boolean>;
  send: (rows: NotificationPendingRow[]) => Promise<void>;
  log: (result: BackfillArticleResult) => void;
  now: () => Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const articleFollowerNoticeKey = (articleId: number) =>
  `${NEW_ARTICLE_FROM_FOLLOWING_TYPE}:${articleId}`;

/**
 * Dry run unless `execute`. A key that already exists is skipped: the job or an earlier backfill run
 * sent it. `resendExisting` tops up a key that was sent to only part of its followers; the worker
 * skips everyone who already has it.
 */
export async function backfillArticleFollowerNotices(
  {
    articleIds,
    maxAgeDays,
    execute,
    resendExisting = false,
  }: { articleIds: number[]; maxAgeDays: number; execute: boolean; resendExisting?: boolean },
  deps: BackfillDeps
): Promise<BackfillArticleResult[]> {
  const ids = [...new Set(articleIds)];
  const rows = await deps.readRows(newArticleFromFollowingQuery({ articleIds: ids, maxAgeDays }));
  const articles = new Map((await deps.readArticles(ids)).map((a) => [a.id, a]));
  const oldest = deps.now().getTime() - maxAgeDays * DAY_MS;

  const results: BackfillArticleResult[] = [];
  for (const articleId of ids) {
    const key = articleFollowerNoticeKey(articleId);
    const mine = rows.filter((r) => r.key === key);
    const keyExists = await deps.keyExists(key);
    const article = articles.get(articleId);

    let outcome: BackfillArticleOutcome;
    if (!article) outcome = 'not-found';
    else if (!article.publishedAt || article.publishedAt.getTime() <= oldest) outcome = 'too-old';
    else if (!mine.length) outcome = 'no-recipients';
    else if (keyExists && !resendExisting) outcome = 'skipped-existing';
    else if (!execute) outcome = 'would-send';
    else {
      await deps.send([
        {
          key,
          type: NEW_ARTICLE_FROM_FOLLOWING_TYPE,
          category: articleNotifications[NEW_ARTICLE_FROM_FOLLOWING_TYPE].category,
          details: mine[0].details,
          dedupeKey: null,
          users: [...new Set(mine.map((r) => r.userId))],
        },
      ]);
      outcome = 'sent';
    }

    const result = { articleId, key, recipients: mine.length, keyExists, outcome };
    deps.log(result);
    results.push(result);
  }
  return results;
}
