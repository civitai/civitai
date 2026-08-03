import { describe, expect, it } from 'vitest';
import { getCanonicalSlugDestination } from '~/utils/canonical-slug';

describe('getCanonicalSlugDestination', () => {
  it('redirects when the slug is missing', () => {
    expect(
      getCanonicalSlugDestination({
        basePath: '/challenges/events',
        id: 42,
        title: 'Summer Art Festival',
      })
    ).toBe('/challenges/events/42/summer-art-festival');
  });

  it('redirects when the slug is stale', () => {
    expect(
      getCanonicalSlugDestination({
        basePath: '/challenges/events',
        id: 42,
        title: 'Summer Art Festival',
        currentSlug: 'winter-art-festival',
      })
    ).toBe('/challenges/events/42/summer-art-festival');
  });

  it('returns null when the slug is already canonical', () => {
    expect(
      getCanonicalSlugDestination({
        basePath: '/challenges/events',
        id: 42,
        title: 'Summer Art Festival',
        currentSlug: 'summer-art-festival',
      })
    ).toBeNull();
  });

  it('returns null when the title slugifies to nothing, so the redirect cannot loop', () => {
    expect(
      getCanonicalSlugDestination({ basePath: '/challenges/events', id: 42, title: '日本語' })
    ).toBeNull();
    expect(getCanonicalSlugDestination({ basePath: '/challenges', id: 7, title: '...' })).toBeNull();
  });

  it('preserves the passthrough query string', () => {
    expect(
      getCanonicalSlugDestination({
        basePath: '/challenges/events',
        id: 42,
        title: 'Summer Art Festival',
        queryString: '?sort=Newest',
      })
    ).toBe('/challenges/events/42/summer-art-festival?sort=Newest');
  });
});
