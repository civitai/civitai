import { describe, expect, it } from 'vitest';

import {
  APP_STORE_QUERY_LENGTH_BUCKETS,
  APP_SURFACES,
  appVisitHref,
  parseAppSurface,
  referrerHostOf,
  resolveAppOpenSurface,
  storeQueryLengthBucket,
  withAppSurface,
} from '~/shared/utils/app-store-telemetry';

describe('parseAppSurface', () => {
  it.each(APP_SURFACES)('accepts %s', (s) => expect(parseAppSurface(s)).toBe(s));

  it.each([
    ['undefined', undefined],
    ['an unknown value', 'banner'],
    ['a repeated param', ['detail', 'store_card']],
    ['a near-miss', 'Store_Card'],
    ['a number', 1],
  ])('reads %s as direct', (_l, raw) => expect(parseAppSurface(raw)).toBe('direct'));
});

describe('resolveAppOpenSurface', () => {
  it('an explicit surface wins over the sub-listing inference', () => {
    expect(resolveAppOpenSurface('made_with', true)).toBe('made_with');
  });
  it('a valid sub-listing id without a surface is a sub-listing launch', () => {
    expect(resolveAppOpenSurface(undefined, true)).toBe('sub_listing');
  });
  it('nothing is direct', () => {
    expect(resolveAppOpenSurface(undefined, false)).toBe('direct');
    expect(resolveAppOpenSurface('nope', false)).toBe('direct');
  });
});

describe('withAppSurface', () => {
  it('appends to a bare path', () => {
    expect(withAppSurface('/apps/run/my-app', 'detail')).toBe('/apps/run/my-app?src=detail');
  });
  it('keeps other pairs and their order, and a hash', () => {
    expect(withAppSurface('/apps/run/x/p?sl=asl_1&from=home#top', 'sub_listing')).toBe(
      '/apps/run/x/p?sl=asl_1&from=home&src=sub_listing#top'
    );
  });
  it('replaces an existing src rather than adding a second', () => {
    expect(withAppSurface('/apps/run/x?src=detail&a=1', 'store_card')).toBe(
      '/apps/run/x?a=1&src=store_card'
    );
  });
  it.each(['https://ext.example/app', '//evil.example/x', 'mailto:a@b.c'])(
    'never touches a non-site href (%s)',
    (href) => expect(withAppSurface(href, 'detail')).toBe(href)
  );
});

describe('appVisitHref', () => {
  it('is an in-site path naming only the listing id and the surface', () => {
    expect(appVisitHref('apl_01ABC', 'store_card')).toBe('/apps/go/apl_01ABC?src=store_card');
  });
  it('encodes the id', () => {
    expect(appVisitHref('a/b?c', 'detail')).toBe('/apps/go/a%2Fb%3Fc?src=detail');
  });
});

describe('referrerHostOf', () => {
  it('keeps the host only, lowercased', () => {
    expect(referrerHostOf('https://Www.Example.COM/path/to?q=private#frag')).toBe(
      'www.example.com'
    );
    expect(referrerHostOf('http://example.org:8080/x')).toBe('example.org');
  });
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['an array', ['https://a.example']],
    ['unparseable', 'not a url'],
    ['a javascript: url', 'javascript:alert(1)'],
    ['a data: url', 'data:text/html,hi'],
    ['an oversized host', `https://${'a'.repeat(250)}.example/`],
  ])('returns null for %s', (_l, raw) => expect(referrerHostOf(raw)).toBeNull());
});

describe('storeQueryLengthBucket', () => {
  // Every boundary, both sides. Lengths are of the TRIMMED text.
  it.each([
    ['', '0'],
    ['   ', '0'],
    [null, '0'],
    [undefined, '0'],
    ['a', '1-3'],
    ['abc', '1-3'],
    ['  abc  ', '1-3'],
    ['abcd', '4-10'],
    ['x'.repeat(10), '4-10'],
    ['x'.repeat(11), '11-30'],
    ['x'.repeat(30), '11-30'],
    ['x'.repeat(31), '31+'],
    ['x'.repeat(5000), '31+'],
  ] as const)('%j -> %s', (query, bucket) => {
    expect(storeQueryLengthBucket(query)).toBe(bucket);
  });

  it('only ever returns a declared bucket', () => {
    for (let n = 0; n < 60; n++) {
      expect(APP_STORE_QUERY_LENGTH_BUCKETS).toContain(storeQueryLengthBucket('q'.repeat(n)));
    }
  });
});
