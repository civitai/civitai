import { describe, expect, it } from 'vitest';
import { articleFeedUrlFromLegacySearch } from '~/components/Article/Infinite/article-feed-search';
import { toSemanticArticleSearchInput } from '~/components/Article/article.utils';
import { ArticleSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

describe('articleFeedUrlFromLegacySearch', () => {
  it('carries an old articles search onto the feed, with its tag names in the query', () => {
    const url = articleFeedUrlFromLegacySearch({
      query: 'lora',
      tags: ['guide', 'training'],
      users: 'someone',
    });
    const params = new URL(url, 'https://x').searchParams;
    expect(url.startsWith('/articles?')).toBe(true);
    expect(params.get('query')).toBe('lora guide training');
    expect(params.get('username')).toBe('someone');
  });

  it('lands an empty search on the bare feed', () => {
    expect(articleFeedUrlFromLegacySearch({})).toBe('/articles');
  });
});

describe('toSemanticArticleSearchInput', () => {
  it("sends the feed's filters the search takes, under the search's names", () => {
    expect(
      toSemanticArticleSearchInput(
        {
          tags: [4],
          username: 'someone',
          period: MetricTimeframe.Week,
          followed: true,
          favorites: true,
          hidden: true,
          collectionId: 9,
          sort: ArticleSort.MostBookmarks,
        },
        'lora',
        3
      )
    ).toEqual({
      query: 'lora',
      browsingLevel: 3,
      tagIds: [4],
      usernames: ['someone'],
      period: MetricTimeframe.Week,
      followed: true,
      favorites: true,
      hidden: true,
      collectionId: 9,
    });
  });
});
