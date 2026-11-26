import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ServerDomain from '~/server/utils/server-domain';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import '~/pages/apps/[appBlockId]';

/**
 * The legacy `/apps/<appBlockId>` route's R/X gate, through the page's `getServerSideProps`.
 *
 * `legacyListingSlugForViewer` is tested on its own with a `mature` argument the test supplies;
 * this file covers the page's wiring of that argument (host + the viewer's browsing level). A
 * wrong wiring puts an R/X app's slug in the redirect `Location` header, so every case asserts
 * the whole result: a redirect to the slug, or a bare 404.
 *
 * Lives under `src/tests/`, not `src/pages/`: Next treats every file under `pages/` as a route.
 */

const { capturedResolver } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

// The viewer is past the store-scope gate, so only the rating gate decides.
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  resolveStoreVisibilityScope: async () => 'full',
}));

// The red domain comes from env, unset in tests; pin it to civitai.red.
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  isRedCapableHost: (host: string | null | undefined) =>
    host === 'civitai.red' || host === 'www.civitai.red',
}));

const findListing = dbMock.dbRead.appListing.findFirst;

const APP_BLOCK_ID = 'apb_01HZLEGACYROUTE';
const SLUG = 'rated-r-app';
const REDIRECT_TO_SLUG = {
  redirect: { destination: `/apps/store-preview/${SLUG}`, permanent: false },
};
const NOT_FOUND = { notFound: true };

// Browsing levels (NsfwLevel bits: PG=1, PG13=2, R=4, X=8).
const viewerWith = (browsingLevel: number) => ({ id: 51, showNsfw: true, browsingLevel });
const PG_VIEWER = viewerWith(1);
const R_VIEWER = viewerWith(7);
const X_VIEWER = viewerWith(15);

function run(host: string, user?: Record<string, unknown>) {
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn({
    // `canViewNsfw` is what the mature-capable site grants; the viewer's own level is then read
    // from their settings (`getServerBrowsingLevel`).
    features: { appListings: true, canViewNsfw: true },
    ctx: { params: { appBlockId: APP_BLOCK_ID }, req: { headers: { host } } },
    session: user ? { user } : null,
  });
}

describe('legacy app route SSR — R/X apps follow the site and the browsing level', () => {
  beforeEach(() => {
    findListing.mockResolvedValue({ slug: SLUG, contentRating: 'r' });
  });

  it('🔴 off civitai.red an R app 404s, even for a viewer with every mature level enabled', async () => {
    expect(await run('civitai.com', X_VIEWER)).toEqual(NOT_FOUND);
  });

  it('🔴 on civitai.red an R app 404s for a PG-only viewer and for a signed-out one', async () => {
    expect(await run('civitai.red', PG_VIEWER)).toEqual(NOT_FOUND);
    expect(await run('civitai.red')).toEqual(NOT_FOUND);
  });

  it('on civitai.red an R-enabled viewer is redirected to the R app', async () => {
    expect(await run('civitai.red', R_VIEWER)).toEqual(REDIRECT_TO_SLUG);
  });

  it('a PG app redirects for a PG-only viewer on either host (the gate is R/X only)', async () => {
    findListing.mockResolvedValue({ slug: SLUG, contentRating: 'pg' });
    expect(await run('civitai.com', PG_VIEWER)).toEqual(REDIRECT_TO_SLUG);
    expect(await run('civitai.red', PG_VIEWER)).toEqual(REDIRECT_TO_SLUG);
  });
});
