import { describe, expect, it } from 'vitest';
import { articleEditEventCard } from '~/components/Article/article-edit-event-card.utils';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

const COVER = { id: 42 };
const article = (extra: Partial<Parameters<typeof articleEditEventCard>[0] & object> = {}) => ({
  id: 7,
  userId: 1,
  status: ArticleStatus.Published,
  coverImage: COVER,
  ...extra,
});

describe('articleEditEventCard', () => {
  it('offers the owner a card on the article, previewed on its cover', () => {
    expect(articleEditEventCard(article(), { id: 1 })).toEqual({
      articleId: 7,
      coverImage: COVER,
      showDraftNote: false,
    });
  });

  it('shows the draft note until the article is published', () => {
    for (const status of [ArticleStatus.Draft, ArticleStatus.Processing, ArticleStatus.Unpublished])
      expect(articleEditEventCard(article({ status }), { id: 1 })?.showDraftNote).toBe(true);
  });

  it('passes no cover for an article without one', () => {
    expect(
      articleEditEventCard(article({ coverImage: null }), { id: 1 })?.coverImage
    ).toBeUndefined();
  });

  it('offers nothing to anyone but the owner, a moderator editing it included', () => {
    expect(articleEditEventCard(article(), { id: 2 })).toBeUndefined();
    expect(articleEditEventCard(article(), undefined)).toBeUndefined();
    expect(articleEditEventCard(article(), null)).toBeUndefined();
    expect(articleEditEventCard(undefined, { id: 1 })).toBeUndefined();
  });
});
