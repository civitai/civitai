import { describe, expect, it } from 'vitest';
import { hasImageDetailQueryFilters } from '~/components/Image/image-query-params';

describe('hasImageDetailQueryFilters', () => {
  it('opens no feed carousel for a search query alone', () => {
    expect(hasImageDetailQueryFilters({ query: 'castle' })).toBe(false);
  });

  it('still does for a feed filter, with or without a query', () => {
    expect(hasImageDetailQueryFilters({ query: 'castle', modelId: 1 })).toBe(true);
    expect(hasImageDetailQueryFilters({}, 7)).toBe(true);
  });
});
