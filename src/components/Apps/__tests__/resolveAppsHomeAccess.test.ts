import { describe, expect, it } from 'vitest';
import { resolveAppsHomeAccess } from '~/components/Apps/resolveAppsHomeAccess';

/**
 * The `/apps` SSR decision: the store gate, then old-store-link and signed-out redirects
 * to `/apps/store`, else the "My apps" home. Every expected value is a literal.
 */

const STORE = { appListings: true };
const SIGNED_IN = { id: 7 };

describe('resolveAppsHomeAccess', () => {
  it('signed in, no store params → renders the home', () => {
    expect(resolveAppsHomeAccess({ features: STORE, user: SIGNED_IN, query: {} })).toEqual({
      props: {},
    });
  });

  it('🔴 signed out → the store', () => {
    expect(resolveAppsHomeAccess({ features: STORE, user: null, query: {} })).toEqual({
      redirect: { destination: '/apps/store', permanent: false },
    });
    expect(resolveAppsHomeAccess({ features: STORE, user: undefined })).toEqual({
      redirect: { destination: '/apps/store', permanent: false },
    });
  });

  it('🔴 an old store link (store params on /apps) → the store, query preserved', () => {
    expect(
      resolveAppsHomeAccess({
        features: STORE,
        user: SIGNED_IN,
        query: { category: 'generation', sort: 'newest', utm_source: 'newsletter' },
      })
    ).toEqual({
      redirect: {
        destination: '/apps/store?category=generation&sort=newest&utm_source=newsletter',
        permanent: false,
      },
    });
  });

  it.each([
    ['kind', { kind: 'offsite' }, '/apps/store?kind=offsite'],
    ['category', { category: 'utility' }, '/apps/store?category=utility'],
    ['sort', { sort: 'popular' }, '/apps/store?sort=popular'],
    ['query', { query: 'upscale' }, '/apps/store?query=upscale'],
    // An INVALID value is still an old store link: the store degrades it, so send it there.
    ['an invalid value', { category: 'hats' }, '/apps/store?category=hats'],
  ])('each store key on its own redirects: %s', (_label, query, destination) => {
    expect(resolveAppsHomeAccess({ features: STORE, user: SIGNED_IN, query })).toEqual({
      redirect: { destination, permanent: false },
    });
  });

  it('a repeated key and an encoded value round-trip', () => {
    expect(
      resolveAppsHomeAccess({
        features: STORE,
        user: SIGNED_IN,
        query: { query: 'a&b=c', ref: ['x', 'y'] },
      })
    ).toEqual({
      redirect: { destination: '/apps/store?query=a%26b%3Dc&ref=x&ref=y', permanent: false },
    });
  });

  it('a repeated key, an empty value and a null: kept, kept as `k=`, dropped', () => {
    expect(
      resolveAppsHomeAccess({
        features: STORE,
        user: SIGNED_IN,
        query: {
          category: 'generation',
          tag: ['b', 'a', 'b'],
          q: '',
          // Next never sends a null, but a hand-built query can: it must not become "null".
          ref: null as unknown as undefined,
        },
      })
    ).toEqual({
      redirect: {
        destination: '/apps/store?category=generation&tag=b&tag=a&tag=b&q=',
        permanent: false,
      },
    });
  });

  it('a non-store param alone does NOT redirect a signed-in viewer', () => {
    expect(
      resolveAppsHomeAccess({ features: STORE, user: SIGNED_IN, query: { utm_source: 'mail' } })
    ).toEqual({ props: {} });
  });

  it('🔴 the store gate comes FIRST: no store access → notFound, never a redirect', () => {
    for (const user of [null, SIGNED_IN]) {
      expect(
        resolveAppsHomeAccess({ features: {}, user, query: { category: 'generation' } })
      ).toEqual({ notFound: true });
    }
    expect(resolveAppsHomeAccess({ features: undefined, user: SIGNED_IN })).toEqual({
      notFound: true,
    });
  });
});
