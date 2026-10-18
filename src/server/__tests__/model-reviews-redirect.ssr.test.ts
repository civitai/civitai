import { describe, expect, it, vi } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's
// 60s budget. See vitest.config.mts.
import { getServerSideProps } from '~/pages/models/[id]/reviews';

/**
 * `/models/<id>/reviews` — the SSR wiring of `getModelReviewsRedirect`: near-duplicate review URLs
 * must come back as a permanent redirect to the listing, and the listing itself must not.
 * The predicate's cases live in `model-reviews-url.test.ts`; this proves the page calls it.
 */

vi.mock('~/server/utils/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/flipt/client', () => ({
  isFliptSync: () => null,
  ensureFliptInitialized: async () => undefined,
}));

let nextHost = 0;
// A `/_next/data` URL is a client-nav fetch, which skips the SSG prefetch: the redirect decision
// runs before it either way, and the non-redirect case then resolves without a database.
const run = async (query: Record<string, string | string[]>) =>
  (await (getServerSideProps as any)({
    params: { id: '4201' },
    req: {
      url: '/_next/data/build/models/4201/reviews.json',
      headers: { host: `case-${nextHost++}.civitai.com`, 'cf-ipcountry': 'US' },
      cookies: {},
    },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: { id: '4201', ...query },
    resolvedUrl: '/models/4201/reviews',
  })) as any;

describe('/models/[id]/reviews near-duplicate redirect', () => {
  it.each([
    [
      'a repeated review dialog',
      { modelVersionId: '7', dialog: ['resourceReview', 'resourceReview'], reviewId: '9' },
    ],
    ['a per-review URL', { modelVersionId: '7', reviewId: '9' }],
    [
      'HTML-escaped params',
      { modelVersionId: '7', 'amp;dialog': 'resourceReview', 'amp;reviewId': '9' },
    ],
  ])('redirects %s to the listing', async (_, query) => {
    expect((await run(query)).redirect).toEqual({
      destination: '/models/4201/reviews?modelVersionId=7',
      permanent: true,
    });
  });

  // The canonical this page used to emit. It 404'd (the query failed validation) instead of
  // consolidating onto the listing.
  it('redirects `?modelVersionId=undefined` to the unfiltered listing', async () => {
    expect((await run({ modelVersionId: 'undefined' })).redirect).toEqual({
      destination: '/models/4201/reviews',
      permanent: true,
    });
  });

  it('still redirects the single review dialog it always did', async () => {
    expect((await run({ dialog: 'resourceReview', reviewId: '9' })).redirect?.destination).toBe(
      '/models/4201/reviews'
    );
  });

  it('404s a non-numeric model id instead of redirecting it', async () => {
    const result = await (getServerSideProps as any)({
      params: { id: 'abc' },
      req: {
        url: '/_next/data/build/models/abc/reviews.json',
        headers: { host: `case-${nextHost++}.civitai.com` },
        cookies: {},
      },
      res: { setHeader: vi.fn(), getHeader: vi.fn() },
      query: { id: 'abc', reviewId: '9' },
      resolvedUrl: '/models/abc/reviews',
    });
    expect(result).toEqual({ notFound: true });
  });

  it('renders the listing', async () => {
    const result = await run({ modelVersionId: '7', page: '2' });
    expect(result.redirect).toBeUndefined();
    expect(result.notFound).toBeUndefined();
  });
});
