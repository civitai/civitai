import type { Prisma } from '@prisma/client';
import { Flags } from '~/shared/utils/flags';
import { ArticleIngestionStatus, ArticleStatus, Availability } from '~/shared/utils/prisma/enums';

export type ArticleReader = { id?: number; isModerator?: boolean } | undefined;

type ReadableArticle = {
  availability: Availability;
  userId: number | null;
  publishedAt: Date | null;
  status: ArticleStatus;
  ingestion: ArticleIngestionStatus;
};

/** The article availability rule for reads. */
export function canViewArticle(
  article: { availability: Availability; userId: number | null },
  viewer: ArticleReader
) {
  if (article.availability !== Availability.Private) return true;
  return !!viewer?.isModerator || (viewer?.id !== undefined && article.userId === viewer.id);
}

const liveArticleWhere = {
  publishedAt: { not: null },
  status: ArticleStatus.Published,
  ingestion: ArticleIngestionStatus.Scanned,
} satisfies Prisma.ArticleWhereInput;

/** The publish half of `canReadArticle` as a query filter; availability is checked in code. */
export function articleReadableWhere(viewer: ArticleReader): Prisma.ArticleWhereInput {
  if (viewer?.isModerator) return {};
  return {
    OR: [liveArticleWhere, ...(viewer?.id !== undefined ? [{ userId: viewer.id }] : [])],
  };
}

/** The columns `canReadArticle` and `articleWithinBrowsingLevel` read. */
export const articleReadSelect = {
  userId: true,
  nsfwLevel: true,
  publishedAt: true,
  status: true,
  ingestion: true,
  availability: true,
} satisfies Prisma.ArticleSelect;

/** Whether a viewer may read an article at all: live and available, or theirs, or a moderator. */
export function canReadArticle(article: ReadableArticle, viewer: ArticleReader) {
  if (viewer?.isModerator) return true;
  const isOwner = viewer?.id !== undefined && article.userId === viewer.id;
  const isLive =
    article.publishedAt !== null &&
    article.status === ArticleStatus.Published &&
    article.ingestion === ArticleIngestionStatus.Scanned;
  return (isOwner || isLive) && canViewArticle(article, viewer);
}

/**
 * getArticles' browsing-level rule: the level must intersect the article's, except that its author
 * and moderators also see it unrated (nsfwLevel 0).
 */
export function articleWithinBrowsingLevel(
  article: { nsfwLevel: number; userId: number | null },
  viewer: ArticleReader,
  browsingLevel: number
) {
  if (Flags.intersects(article.nsfwLevel, browsingLevel)) return true;
  const privileged =
    !!viewer?.isModerator || (viewer?.id !== undefined && article.userId === viewer.id);
  return article.nsfwLevel === 0 && privileged;
}
