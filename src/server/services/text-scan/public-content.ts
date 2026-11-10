import type { Prisma } from '@prisma/client';
import type { ArticleMetadata } from '~/server/schema/article.schema';
import { ArticleStatus, Availability, ModelStatus } from '~/shared/utils/prisma/enums';

// Scheduled counts as public so the verdict exists by the time the content goes live.
export const PUBLIC_MODEL_STATUSES: ModelStatus[] = [ModelStatus.Published, ModelStatus.Scheduled];

export const PUBLIC_MODEL_WHERE = {
  deletedAt: null,
  status: { in: PUBLIC_MODEL_STATUSES },
  availability: { not: Availability.Private },
} satisfies Prisma.ModelWhereInput;

export function isPublicModel(model: { status: ModelStatus; availability: Availability }) {
  return (
    PUBLIC_MODEL_STATUSES.includes(model.status) && model.availability !== Availability.Private
  );
}

// Availability is deliberately not read: a Private article's ingestion waits on the verdict too.
// Keep in step with `article-schedule.helpers.ts`, which decides when a scheduled Draft goes live.
// `shared`: the article has an active share link, so it is checked like a published one.
export function isPublicArticle(
  article: { status: ArticleStatus; scheduledAt: Date | null },
  shared = false
) {
  return (
    article.status === ArticleStatus.Published ||
    articleAwaitsTextVerdict(article) ||
    (shared && isShareableArticleStatus(article.status))
  );
}

/** Statuses a share link may be created for and read in. */
export function isShareableArticleStatus(status: ArticleStatus) {
  return status === ArticleStatus.Draft || status === ArticleStatus.Unpublished;
}

/**
 * A block took this article down before its author asked for it to go live (an unscheduled Draft,
 * or Unpublished), so there is no publish to tell them was taken down. Processing and a scheduled
 * Draft are publishes the author asked for, as before share links.
 */
export function blockReturnsToAuthor(article: { status: ArticleStatus; scheduledAt: Date | null }) {
  return isShareableArticleStatus(article.status) && !isPublicArticle(article);
}

/**
 * The metadata a block moving an article to UnpublishedViolation writes: the status a restore
 * returns it to, replacing any an earlier block left behind. A Draft, scheduled or not, returns as a
 * Draft (the restore clears its schedule, so the author schedules it again), and Unpublished as
 * Unpublished. Processing records Published, as it may have no `publishedAt` yet to restore by; a
 * Published article needs no key, since a row without one restores by `publishedAt`.
 */
export function violationMetadata(
  article: { status: ArticleStatus },
  metadata: ArticleMetadata
): ArticleMetadata {
  const rest = { ...metadata };
  delete rest.statusBeforeViolation;
  if (article.status === ArticleStatus.Published) return rest;
  return {
    ...rest,
    statusBeforeViolation:
      article.status === ArticleStatus.Processing
        ? 'Published'
        : (article.status as 'Draft' | 'Unpublished'),
  };
}

// Processing and a scheduled Draft go live only once the text verdict is in.
export function articleAwaitsTextVerdict(article: {
  status: ArticleStatus;
  scheduledAt: Date | null;
}) {
  return (
    article.status === ArticleStatus.Processing ||
    (article.status === ArticleStatus.Draft && !!article.scheduledAt)
  );
}
