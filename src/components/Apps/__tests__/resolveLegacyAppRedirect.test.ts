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
 * Break-it checks these are written to survive. Each mutation was applied to the
 * source, the suite run, the named failures confirmed, and the source reverted —
 * the counts below are MEASURED, not estimated:
 *   - turn the no-listing branch into `{ redirect: { destination: '/apps' } }`
 *     → 6 FAIL (the `notFound` cases).
 *   - drop `encodeURIComponent` → 4 FAIL (the encoding/containment cases).
 *   - flip `permanent` to true → 5 FAIL.
 *   - drop the `.trim()` on the slug → 3 FAIL.
 *   - move the store-visibility gate AFTER the lookup → 2 FAIL (the ordering
 *     cases in `resolveLegacyAppRoute`).
 *   - drop `status: 'approved'` from the query → 1 FAIL (the query-shape pin).
 *   - pass the UNTRIMMED `args.appBlockId` to the lookup while still guarding the
 *     trimmed value → 1 FAIL (the trim case). 🔴 This one previously survived the
 *     WHOLE suite; see that test for why.
 *   - rewrite a dot-only slug in the destination → 1 FAIL (the narrowed
 *     traversal-claim pin).
 *
 * 🔴 Two assertions in this file were REMOVED rather than kept, because they could
 * not fail: an `includes('/')` sub-assertion following a literal-equality assertion
 * over the same string, twice. They were themselves added by an earlier audit
 * looking for exactly that defect. The property they claimed to guard now lives in
 * its own `it` over inputs no literal in this file constrains. A no-op wearing the
 * name of a guard is worse than no guard — it reads as coverage.
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
    //
    // 🔴 This `it` used to carry a trailing `expect(slugSegment.includes('/'))
    // .toBe(false)`. It was DEAD: the literal equality on the same string one line
    // above already fails for any mutation that admits a `/`, so the sub-assertion
    // could never be the thing that failed. Proven, not assumed — the killed-test
    // set was byte-identical across all 8 mutations with it deleted. The real
    // no-second-segment property is now pinned below over inputs that NO literal
    // in this file constrains, which is what makes it able to fail on its own.
    const result = resolveLegacyAppRedirect({ slug: 'some-app' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    const slugSegment = result.redirect.destination.slice(STORE_PREVIEW_PATH_PREFIX.length);
    expect(slugSegment).toBe('some-app');
  });

  it('NO slug value can introduce a second path segment', () => {
    // The containment property on its own terms: a set of separator-bearing slugs,
    // none of which is pinned by a literal-equality assertion anywhere in this file,
    // asserted structurally. Drop `encodeURIComponent` and every case here fails —
    // which is the point: this `it` can be the sole reason a mutation is caught.
    for (const slug of ['a/b', '/', '//', '%2F', 'x/../y', 'a//b/c', '/leading', 'trailing/']) {
      const result = resolveLegacyAppRedirect({ slug });
      if (!('redirect' in result))
        throw new Error(`expected a redirect for ${JSON.stringify(slug)}`);
      const segments = result.redirect.destination
        .slice(STORE_PREVIEW_PATH_PREFIX.length)
        .split('/')
        .filter(Boolean);
      expect(segments, `slug ${JSON.stringify(slug)} must stay one path segment`).toHaveLength(1);
    }
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
    //
    // 🔴 A trailing `...includes('/')).toBe(false)` used to sit here and was DEAD
    // for the same reason as the one removed above: the literal equality on the
    // whole destination already fails for any mutation that lets a `/` through.
    // The separator property now lives in its own `it` over un-pinned inputs.
    const result = resolveLegacyAppRedirect({ slug: '//evil.example' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/%2F%2Fevil.example');
  });

  it('a SEPARATOR-BEARING traversal slug cannot climb out of /apps/store-preview/', () => {
    const result = resolveLegacyAppRedirect({ slug: '../../login' });
    if (!('redirect' in result)) throw new Error('expected a redirect');
    expect(result.redirect.destination).toBe('/apps/store-preview/..%2F..%2Flogin');
  });

  it('a DOT-ONLY slug stays on-origin, but does NOT stay under the prefix', () => {
    // 🔴 Narrowing an overstated claim. `encodeURIComponent('..') === '..'` — the
    // encode does nothing to a slug with no separator in it, so a slug of exactly
    // `..` yields `/apps/store-preview/..`, and dot-segment removal (RFC 3986 §5.2.4,
    // which every browser and Next's router apply) resolves that to `/apps/`. The
    // previous docstring said traversal "cannot climb out of /apps/store-preview/";
    // it was pinned only by the slash-bearing `../../login` case above, and for the
    // dot-only input the claim is false.
    //
    // What DOES hold, and is all that was ever security-relevant: the destination
    // never leaves the origin and never reaches an arbitrary path — one level up
    // from the detail route is the apps index, which is where the redirect's own
    // rejected-alternative branch would have sent people anyway.
    //
    // Unreachable in practice: a stored slug must match SLUG_REGEX
    // (`/^[a-z][a-z0-9-]*[a-z0-9]$/`, publish-request.schema.ts), which admits no
    // `.` at all. Pinned so the claim in the docstring matches the code's actual
    // guarantee rather than a stronger one.
    for (const slug of ['..', '.']) {
      const result = resolveLegacyAppRedirect({ slug });
      if (!('redirect' in result)) throw new Error(`expected a redirect for ${slug}`);
      expect(result.redirect.destination).toBe(`/apps/store-preview/${slug}`);
      // Still a relative, same-origin path — the only property claimed.
      expect(new URL(result.redirect.destination, 'https://civitai.com').origin).toBe(
        'https://civitai.com'
      );
    }
    // And the resolved form, stated explicitly rather than implied: `..` lands on
    // the apps index, NOT anywhere a viewer could not already reach.
    expect(new URL('/apps/store-preview/..', 'https://civitai.com').pathname).toBe('/apps/');
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

  it('the route param is TRIMMED before it reaches the lookup', async () => {
    // 🔴 The guard and the lookup must read the SAME value. `resolveLegacyAppRoute`
    // trims the param, rejects the trimmed empty, and must then query the TRIMMED
    // string. Passing `args.appBlockId` (untrimmed) to `findApprovedListingSlug`
    // while still guarding the trimmed value is a one-word mutation that left the
    // suite fully green before this case existed — every other fixture id in this
    // file is whitespace-free, and the only `toHaveBeenCalledWith` used a clean
    // `'apb_x'`, so nothing could see the difference. In production that mutation
    // sends `'  apb_x  '` to a Prisma equality filter on a ULID column: it matches
    // nothing, and an approved app 404s instead of redirecting.
    const findApprovedListingSlug = vi.fn(async () => 'vitrine');
    expect(
      await resolveLegacyAppRoute({
        features: granted,
        appBlockId: '  apb_x  ',
        findApprovedListingSlug,
      })
    ).toEqual({ redirect: { destination: '/apps/store-preview/vitrine', permanent: false } });
    expect(findApprovedListingSlug).toHaveBeenCalledWith('apb_x');
    expect(findApprovedListingSlug).toHaveBeenCalledTimes(1);
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
