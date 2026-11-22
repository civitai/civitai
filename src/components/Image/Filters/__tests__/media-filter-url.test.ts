import { describe, expect, it } from 'vitest';
import { appliedRouteQuery } from '~/components/Image/Filters/media-filter-url';

// `?tags=` has no store field, so Apply writes it to the URL, where the feed, the tag bar and the
// feed's search all read it.
describe('appliedRouteQuery', () => {
  const route = { tags: ['5'], period: 'Month', query: 'cats' };

  it('writes the staged tags and drops the params moved into the store', () => {
    expect(appliedRouteQuery(route, { overridden: ['period'], tags: [5, 42] })).toEqual({
      tags: [5, 42],
      query: 'cats',
    });
  });

  it('drops the tags when none are staged (Clear, or the last one removed)', () => {
    expect(appliedRouteQuery(route, { overridden: [], tags: [] })).toEqual({
      period: 'Month',
      query: 'cats',
    });
  });

  it("leaves the URL's tags alone for a dropdown without the tag filter", () => {
    expect(appliedRouteQuery(route, { overridden: ['period'], tags: null })).toEqual({
      tags: ['5'],
      query: 'cats',
    });
  });
});
