import { describe, it, expect } from 'vitest';
import { resolveLegacyAppRedirect, STORE_PREVIEW_PATH_PREFIX } from '../resolveLegacyAppRedirect';

/**
 * S8 / PR-2 — the retirement decision for the legacy `/apps/[appBlockId]` detail
 * route. These are a REAL gate, not a change-detector: the whole PR is two
 * branches, and the second one (no approved listing → `notFound`) is a product
 * decision that a future "helpful" edit would otherwise silently invert into a
 * redirect to `/apps` with nothing failing.
 *
 * Break-it checks these are written to survive:
 *   - turn the no-listing branch into `{ redirect: { destination: '/apps' } }`
 *     → the `notFound` cases below must FAIL.
 *   - drop `encodeURIComponent` → the escaping case must FAIL.
 *   - flip `permanent` to true → the 302 case must FAIL.
 */

describe('resolveLegacyAppRedirect — approved listing → store-preview redirect', () => {
  it('redirects to /apps/store-preview/<slug> as a temporary (302) redirect', () => {
    expect(resolveLegacyAppRedirect({ slug: 'model-benchmarking' })).toEqual({
      redirect: {
        destination: '/apps/store-preview/model-benchmarking',
        permanent: false,
      },
    });
  });

  it('is never a permanent redirect (the route retirement is still reversible)', () => {
    const result = resolveLegacyAppRedirect({ slug: 'vitrine' });
    expect(result).toHaveProperty('redirect');
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.permanent).toBe(false);
    expect(result).not.toHaveProperty('notFound');
  });

  it('always lands under the store-preview path prefix', () => {
    const result = resolveLegacyAppRedirect({ slug: 'some-app' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination.startsWith(STORE_PREVIEW_PATH_PREFIX)).toBe(true);
  });
});

describe('resolveLegacyAppRedirect — NO approved listing → site-standard 404', () => {
  // 🔴 The decided miss behaviour. Listings are created at APPROVAL, so a
  // pending / rejected / never-approved app has no slug to send anyone to. This
  // must be `notFound` — NOT a redirect to `/apps`, which silently dead-ends the
  // owner looking for their own pending app.
  it('slug null (no listing row) → notFound, never a redirect', () => {
    const result = resolveLegacyAppRedirect({ slug: null });
    expect(result).toEqual({ notFound: true });
    expect(result).not.toHaveProperty('redirect');
  });

  it('slug undefined / key absent → notFound, never a redirect', () => {
    expect(resolveLegacyAppRedirect({ slug: undefined })).toEqual({ notFound: true });
    expect(resolveLegacyAppRedirect({})).toEqual({ notFound: true });
    const result = resolveLegacyAppRedirect({});
    expect(result).not.toHaveProperty('redirect');
  });

  it('empty / whitespace-only slug → notFound (not a redirect to the bare prefix)', () => {
    expect(resolveLegacyAppRedirect({ slug: '' })).toEqual({ notFound: true });
    expect(resolveLegacyAppRedirect({ slug: '   ' })).toEqual({ notFound: true });
    expect(resolveLegacyAppRedirect({ slug: '\t\n' })).toEqual({ notFound: true });
  });

  it('a non-string slug (defensive: untyped/JSON input) → notFound', () => {
    // Guards the runtime edge a `string | null` type does not: a DB/serialization
    // surprise must fail closed to 404, never build `/apps/store-preview/[object Object]`.
    expect(resolveLegacyAppRedirect({ slug: 123 as unknown as string })).toEqual({
      notFound: true,
    });
    expect(resolveLegacyAppRedirect({ slug: {} as unknown as string })).toEqual({
      notFound: true,
    });
  });

  it('never returns a redirect to /apps for a missing listing', () => {
    // Named guard for the rejected alternative, so an edit back to it fails here
    // with an obvious message rather than only tripping the toEqual above.
    for (const slug of [null, undefined, '', '  ']) {
      const result = resolveLegacyAppRedirect({ slug });
      const destination = 'redirect' in result ? result.redirect.destination : null;
      expect(destination).not.toBe('/apps');
      expect(destination).toBeNull();
    }
  });
});

describe('resolveLegacyAppRedirect — slug encoding / open-redirect containment', () => {
  it('percent-encodes URL-unsafe characters in the slug', () => {
    const result = resolveLegacyAppRedirect({ slug: 'a b/c?d#e' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/a%20b%2Fc%3Fd%23e');
  });

  it('a protocol-relative slug cannot escape to another origin', () => {
    // `//evil.example` un-encoded would be a protocol-relative URL — an open
    // redirect off civitai.com. Encoded, it stays a path segment.
    const result = resolveLegacyAppRedirect({ slug: '//evil.example' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/%2F%2Fevil.example');
    expect(result.redirect.destination.startsWith(STORE_PREVIEW_PATH_PREFIX)).toBe(true);
  });

  it('path traversal in a slug cannot climb out of /apps/store-preview/', () => {
    const result = resolveLegacyAppRedirect({ slug: '../../login' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/..%2F..%2Flogin');
  });

  it('an ordinary hyphenated slug is passed through unchanged (no over-escaping)', () => {
    const result = resolveLegacyAppRedirect({ slug: 'df-qwen-canvas' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/df-qwen-canvas');
  });

  it('trims surrounding whitespace rather than encoding it into the path', () => {
    const result = resolveLegacyAppRedirect({ slug: '  vitrine  ' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/vitrine');
  });
});
