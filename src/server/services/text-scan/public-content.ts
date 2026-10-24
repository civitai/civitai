import type { Prisma } from '@prisma/client';
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
export function isPublicArticle(article: { status: ArticleStatus; scheduledAt: Date | null }) {
  return article.status === ArticleStatus.Published || articleAwaitsTextVerdict(article);
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
