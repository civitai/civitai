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
 * or Unpublished), so a moderator's restore must return it to its author, not publish it.
 * Processing and a scheduled Draft are publishes the author asked for, as before share links.
 */
export function blockReturnsToAuthor(article: { status: ArticleStatus; scheduledAt: Date | null }) {
  return isShareableArticleStatus(article.status) && !isPublicArticle(article);
}

/**
 * The metadata a block moving an article to UnpublishedViolation writes: the status the restore
 * returns it to, when `blockReturnsToAuthor`, and never a status an earlier block left behind.
 */
export function violationMetadata(
  article: { status: ArticleStatus; scheduledAt: Date | null },
  metadata: ArticleMetadata
): ArticleMetadata {
  const rest = { ...metadata };
  delete rest.statusBeforeViolation;
  return blockReturnsToAuthor(article)
    ? { ...rest, statusBeforeViolation: article.status as 'Draft' | 'Unpublished' }
    : rest;
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
