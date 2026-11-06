import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { recomputeArticleIngestion } from '~/server/services/article.service';
import type { ArticleMetadata } from '~/server/schema/article.schema';
import { lockAccessTokens, revokeActiveAccessTokens } from '~/server/services/access-token.service';
import { isSharedArticle } from '~/server/services/article-share.helpers';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { applyRatingFloor, readRatedEntity } from '~/server/services/text-scan/rated-entities';
import {
  blockReturnsToAuthor,
  isPublicArticle,
  violationMetadata,
} from '~/server/services/text-scan/public-content';
import {
  submitTextModerationOrScan,
  TEXT_SCAN_ENTITY_NOT_PUBLIC,
} from '~/server/services/text-scan/route';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { removeTags } from '~/utils/string-helpers';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

// Article-side hooks for the EntityModeration pipeline. The webhook and the
// retry cron route all `Article` entityType work through this adapter via
// the central registry in `moderation-adapters.ts`.
export const articleModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.article.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, content: true },
    });
    // Must match the string the create/update/rescan paths submit, or the
    // `contentHash` dedup in createXGuardModerationRequest can never hit and the
    // retry cron re-audits content that was already scanned.
    return new Map(
      rows.map((r) => [r.id, [r.title, removeTags(r.content)].filter(Boolean).join(' ')])
    );
  },

  submit: async ({ entityId, content }) => {
    // The scan's own profile gate never reaches the XGuard leg the off and shadow modes run.
    const article = await dbWrite.article.findUnique({
      where: { id: entityId },
      select: { status: true, scheduledAt: true },
    });
    if (article && !isPublicArticle(article) && !(await isSharedArticle(entityId, article.status)))
      return TEXT_SCAN_ENTITY_NOT_PUBLIC;
    return submitTextModerationOrScan({
      entityType: 'Article',
      entityId,
      fromRetry: true,
      xguard: () =>
        submitTextModeration({
          entityType: 'Article',
          entityId,
          content,
          labels: ['nsfw'],
          priority: 'low',
        }),
    });
  },

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

    // If blocked, auto-unpublish and notify. Its share links end in the same write, under the
    // lock a link being created takes, so none outlives the block. The row is read FOR UPDATE, so
    // this writes from the row as it is now, and a write to it that starts later waits for this one.
    if (blocked) {
      const article = await dbWrite.$transaction(async (tx) => {
        await lockAccessTokens(tx, entityId);
        const [article] = await tx.$queryRaw<
          {
            status: ArticleStatus;
            userId: number;
            scheduledAt: Date | null;
            metadata: ArticleMetadata | null;
          }[]
        >`SELECT status, "userId", "scheduledAt", metadata FROM "Article" WHERE id = ${entityId} FOR UPDATE`;
        if (!article || article.status === ArticleStatus.UnpublishedViolation) return null;
        await tx.article.update({
          where: { id: entityId },
          data: {
            status: ArticleStatus.UnpublishedViolation,
            metadata: violationMetadata(article, article.metadata ?? {}),
          },
        });
        await revokeActiveAccessTokens('Article', entityId, tx);
        return article;
      });
      // One its author had not sent live was not unpublished, so there is nothing to tell.
      if (article && !blockReturnsToAuthor(article)) {
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

  // Rating before ingestion: ingestion publishes a Processing article, which must not go
  // live at its pre-verdict level.
  applyTextScan: withCsamHold('Article', async (args) => {
    await applyRatingFloor('Article', args);
    await recomputeArticleIngestion(args.entityId);
  }),
  readRating: (entityId) => readRatedEntity('Article', entityId),
};
