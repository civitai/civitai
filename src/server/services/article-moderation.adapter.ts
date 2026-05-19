import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { recomputeArticleIngestion } from '~/server/services/article.service';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

// Article-side hooks for the EntityModeration pipeline. The webhook and the
// retry cron route all `Article` entityType work through this adapter via
// the central registry in `moderation-adapters.ts`.
export const articleModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.article.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true },
    });
    return new Map(rows.map((r) => [r.id, r.content]));
  },

  submit: ({ entityId, content }) =>
    submitTextModeration({
      entityType: 'Article',
      entityId,
      content,
      labels: ['nsfw'],
      priority: 'low',
    }),

  applyResult: async ({ entityId, blocked, triggeredLabels }) => {
    // Text moderation now only returns whether the article content is NSFW or
    // not. Blocked content is treated as NSFW regardless of triggered labels.
    const isNsfw = blocked || triggeredLabels.some((label) => label.toLowerCase() === 'nsfw');

    // `recordEntityModerationSuccess` (already called by the webhook) has
    // persisted the moderation result. `updateArticleNsfwLevels`'s
    // moderation_floor subquery reads that record directly, so the R floor
    // is applied intrinsically — no parameter or prior write needed.
    if (isNsfw) {
      await updateArticleNsfwLevels([entityId]);
    }

    // If blocked, auto-unpublish and notify.
    if (blocked) {
      const article = await dbWrite.article.findUnique({
        where: { id: entityId },
        select: { status: true, userId: true },
      });
      if (article && article.status !== ArticleStatus.UnpublishedViolation) {
        await dbWrite.article.update({
          where: { id: entityId },
          data: { status: ArticleStatus.UnpublishedViolation },
        });
        await createNotification({
          userId: article.userId,
          category: NotificationCategory.System,
          type: 'system-message',
          key: `article-text-blocked-${entityId}`,
          details: {
            message:
              'Your article was unpublished because its content violates our Terms of Service.',
            url: `/articles/${entityId}`,
          },
        });
      }
    }

    await recomputeArticleIngestion(entityId);
  },

  applyFailure: async ({ entityId }) => {
    await recomputeArticleIngestion(entityId);
  },
};
