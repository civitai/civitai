import type { Prisma } from '@prisma/client';
import { ArticleStatus, Availability, ModelStatus } from '~/shared/utils/prisma/enums';

// Scheduled counts as public so the verdict exists by the time the content goes live.
const PUBLIC_MODEL_STATUSES: ModelStatus[] = [ModelStatus.Published, ModelStatus.Scheduled];

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

// Processing and a scheduled Draft both wait on the verdict to go live, so they must be scanned.
// Private availability still counts for the same reason: its ingestion waits on the verdict too.
const PUBLIC_ARTICLE_STATUSES: ArticleStatus[] = [
  ArticleStatus.Published,
  ArticleStatus.Processing,
];

export function isPublicArticle(article: { status: ArticleStatus; scheduledAt: Date | null }) {
  return (
    PUBLIC_ARTICLE_STATUSES.includes(article.status) ||
    (article.status === ArticleStatus.Draft && !!article.scheduledAt)
  );
}
