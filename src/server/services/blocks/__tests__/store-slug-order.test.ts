import { describe, expect, it } from 'vitest';
import { idsInSlugOrder } from '~/server/services/blocks/store-slug-order';

describe('idsInSlugOrder', () => {
  it('keeps the order of the slugs, not of the rows', () => {
    const rows = [
      { id: 'al_a', slug: 'a' },
      { id: 'al_b', slug: 'b' },
      { id: 'al_c', slug: 'c' },
    ];
    expect(idsInSlugOrder(['c', 'a', 'b'], rows)).toEqual(['al_c', 'al_a', 'al_b']);
  });

  it('skips slugs without a row and repeats', () => {
    const rows = [
      { id: 'al_b', slug: 'b' },
      { id: 'al_a', slug: 'a' },
    ];
    expect(idsInSlugOrder(['x', 'a', 'b', 'a'], rows)).toEqual(['al_a', 'al_b']);
    expect(idsInSlugOrder([], rows)).toEqual([]);
  });
});
