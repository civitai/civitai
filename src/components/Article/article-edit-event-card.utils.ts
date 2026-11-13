import { ArticleStatus } from '~/shared/utils/prisma/enums';

/**
 * Whether the article editor offers the event card, and on what. Only the owner: the equip refuses
 * anyone else, moderators included.
 */
export function articleEditEventCard<TImage>(
  article:
    | { id: number; userId: number; status: ArticleStatus; coverImage?: TImage | null }
    | undefined,
  viewer: { id: number } | null | undefined
) {
  if (!article || !viewer || article.userId !== viewer.id) return undefined;
  return {
    articleId: article.id,
    coverImage: article.coverImage ?? undefined,
    showDraftNote: article.status !== ArticleStatus.Published,
  };
}
