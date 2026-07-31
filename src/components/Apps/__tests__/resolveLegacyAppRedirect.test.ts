import { describe, it, expect, vi } from 'vitest';
import {
  approvedListingSlugQuery,
  resolveLegacyAppRedirect,
  resolveLegacyAppRoute,
  STORE_PREVIEW_PATH_PREFIX,
} from '../resolveLegacyAppRedirect';

/**
 * S8 / PR-2 — the retirement decision for the legacy `/apps/[appBlockId]` detail
 * route. These are a REAL gate, not a change-detector: the whole PR is two
 * branches, and the second one (no approved listing → `notFound`) is a product
 * decision that a future "helpful" edit would otherwise silently invert into a
 * redirect to `/apps` with nothing failing.
 *
 * Break-it checks these are written to survive — each was run against the source
 * and confirmed to fail before being reverted:
 *   - turn the no-listing branch into `{ redirect: { destination: '/apps' } }`
 *     → 5 FAIL (the `notFound` cases).
 *   - drop `encodeURIComponent` → 3 FAIL (the encoding/containment cases).
 *   - flip `permanent` to true → 2 FAIL.
 *   - move the store-visibility gate AFTER the lookup → 2 FAIL (the ordering
 *     cases in `resolveLegacyAppRoute`).
 *   - drop `status: 'approved'` from the query → 1 FAIL (the query-shape pin).
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

  it('the slug occupies exactly one path segment under the prefix', () => {
    // NB: asserting `startsWith(STORE_PREVIEW_PATH_PREFIX)` would be a tautology —
    // the destination is built by concatenating that same exported constant, so it
    // cannot fail. What CAN fail, and is the property worth pinning, is that the
    // slug never introduces a second segment.
    const result = resolveLegacyAppRedirect({ slug: 'some-app' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    const slugSegment = result.redirect.destination.slice(STORE_PREVIEW_PATH_PREFIX.length);
    expect(slugSegment).toBe('some-app');
    expect(slugSegment.includes('/')).toBe(false);
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
      expect('redirect' in result, `slug ${JSON.stringify(slug)} must not redirect`).toBe(false);
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
    // The property that actually matters: no slash survives into the slug segment,
    // so the destination can never resolve as `//host` or climb a directory.
    expect(result.redirect.destination.slice(STORE_PREVIEW_PATH_PREFIX.length).includes('/')).toBe(
      false
    );
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

/**
 * The SSR half. The string concat above is the easy part; the parts that can
 * actually hurt are the GATE ORDERING and the APPROVED-ONLY precondition, and
 * neither is visible to a test of `resolveLegacyAppRedirect` alone — by the time
 * it runs, the gate has already been passed and the slug already handed over.
 * `resolveLegacyAppRoute` takes the lookup as an argument precisely so both are
 * assertable here.
 */
describe('resolveLegacyAppRoute — SSR gate ordering', () => {
  const lookup = (slug: string | null) => vi.fn(async (): Promise<string | null> => slug);

  it('no store visibility → notFound, and the DB is NEVER QUERIED', async () => {
    // 🔴 The load-bearing assertion. Returning notFound is not enough: if the
    // lookup runs first and the gate second, an ungranted viewer still causes a
    // query, and timing/load become a side channel. Assert the call count.
    const findApprovedListingSlug = lookup('model-benchmarking');
    const result = await resolveLegacyAppRoute({
      features: { appBlocks: false, appListings: false },
      appBlockId: 'apb_01KXPENN70SG0RXQKN7WMJMJHF',
      findApprovedListingSlug,
    });
    expect(result).toEqual({ notFound: true });
    expect(findApprovedListingSlug).not.toHaveBeenCalled();
  });

  it('absent / null features → notFound, no query (fails closed)', async () => {
    for (const features of [undefined, null, {}]) {
      const findApprovedListingSlug = lookup('vitrine');
      expect(
        await resolveLegacyAppRoute({ features, appBlockId: 'apb_x', findApprovedListingSlug })
      ).toEqual({ notFound: true });
      expect(findApprovedListingSlug).not.toHaveBeenCalled();
    }
  });

  it('either store-visibility flag grants access (the OR-fallback is preserved)', async () => {
    for (const features of [
      { appBlocks: true, appListings: false },
      { appBlocks: false, appListings: true },
    ]) {
      const findApprovedListingSlug = lookup('vitrine');
      expect(
        await resolveLegacyAppRoute({ features, appBlockId: 'apb_x', findApprovedListingSlug })
      ).toEqual({
        redirect: { destination: '/apps/store-preview/vitrine', permanent: false },
      });
      expect(findApprovedListingSlug).toHaveBeenCalledWith('apb_x');
    }
  });
});

describe('resolveLegacyAppRoute — route param handling', () => {
  const granted = { appBlocks: true };

  it('a missing / non-string route param → notFound without querying', async () => {
    for (const appBlockId of [undefined, null, '', '   ', 123, ['apb_x']]) {
      const findApprovedListingSlug = vi.fn(async () => 'vitrine');
      expect(
        await resolveLegacyAppRoute({ features: granted, appBlockId, findApprovedListingSlug })
      ).toEqual({ notFound: true });
      expect(findApprovedListingSlug).not.toHaveBeenCalled();
    }
  });

  it('a granted viewer + an app WITH an approved listing → the store-preview redirect', async () => {
    const findApprovedListingSlug = vi.fn(async () => 'model-benchmarking');
    expect(
      await resolveLegacyAppRoute({
        features: granted,
        appBlockId: 'apb_01KXPENN70SG0RXQKN7WMJMJHF',
        findApprovedListingSlug,
      })
    ).toEqual({
      redirect: { destination: '/apps/store-preview/model-benchmarking', permanent: false },
    });
  });

  it('a granted viewer + an app with NO approved listing → notFound, never /apps', async () => {
    const findApprovedListingSlug = vi.fn(async () => null);
    const result = await resolveLegacyAppRoute({
      features: granted,
      appBlockId: 'apb_pending',
      findApprovedListingSlug,
    });
    expect(result).toEqual({ notFound: true });
    expect('redirect' in result).toBe(false);
  });
});

describe('approvedListingSlugQuery — the approved-only precondition', () => {
  /**
   * 🔴 This is a contract pin, and it is deliberate. Without it, deleting
   * `status: 'approved'` from the query is a one-word edit that inverts the
   * decided behaviour — every pending and rejected app would start redirecting
   * into the store — while every other test in this file still passes, because
   * they all begin AFTER the lookup has returned.
   */
  it('filters to an approved, non-shadow listing for the given app block', () => {
    expect(approvedListingSlugQuery('apb_01KXPENN70SG0RXQKN7WMJMJHF')).toEqual({
      where: {
        appBlockId: 'apb_01KXPENN70SG0RXQKN7WMJMJHF',
        status: 'approved',
        revisionOfId: null,
      },
      select: { slug: true },
    });
  });

  it('selects the slug and nothing else (no incidental data pulled into SSR)', () => {
    expect(Object.keys(approvedListingSlugQuery('apb_x').select)).toEqual(['slug']);
  });
});
