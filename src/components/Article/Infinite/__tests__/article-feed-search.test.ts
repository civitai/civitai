import { describe, expect, it } from 'vitest';
import { articleFeedUrlFromLegacySearch } from '~/components/Article/Infinite/article-feed-search';

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
