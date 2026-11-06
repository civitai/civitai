import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import '~/pages/apps/run/[slug]/[[...path]]';

/**
 * NSFW-APP-RED-ONLY — run-page SSR gate (`/apps/run/<slug>`).
 *
 * A mature (r/x) page app 404s when the request host is not red-capable; SFW
 * apps render on any host; mature apps render on civitai.red. We mock
 * `createServerSideProps` to capture the resolver (so we can invoke it with a
 * controlled `ctx`/`features`), the registry resolve, and the host gate helper.
 *
 * NOTE: this test lives under `src/tests/` (NOT co-located under `src/pages/`).
 * Next treats every file under `pages/` as a route needing a default export, so
 * a `*.test.ts` there fails `next build`'s route-type validator (tsc/vitest do
 * not catch it). Page modules are imported via the `~/pages/...` alias, matching
 * the rest of `src/tests/api/**`.
 */

const { capturedResolver } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  // Capture the resolver passed by the page so the test can invoke it directly.
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

const { mockResolvePageBlockBySlug } = vi.hoisted(() => ({
  mockResolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: mockResolvePageBlockBySlug },
}));

// The launch's ClickHouse event, which the page sends without awaiting.
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: vi.fn(async () => undefined),
}));
// "Opening clears the hide" read on a signed-in public launch (its own test:
// run-page-reopen-clears-hide.test.ts). Stubbed so this file never reaches the settings cache.
vi.mock('~/server/services/blocks/my-apps-hidden.service', () => ({
  isMyAppHidden: vi.fn(async () => false),
}));

// Real-ish host gate: mature (r/x) requires civitai.red.
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  ratingAllowedOnHost: (rating: unknown, host: string) => {
    const mature = typeof rating === 'string' && ['r', 'x'].includes(rating.toLowerCase());
    if (!mature) return true;
    return host === 'civitai.red' || host === 'www.civitai.red';
  },
}));

// The page imports React/Mantine component bits at module top; stub the heavy
// ones so importing the page module in a node unit test doesn't pull a DOM.
vi.mock('@mantine/core', () => ({ Box: () => null, useComputedColorScheme: () => 'dark' }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const PAGE = {
  appBlockId: 'ab_1',
  blockId: 'cool-app',
  appId: 'app_1',
  iframeSrc: 'https://cool-app.civit.ai',
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Cool App',
  pageTitle: 'Cool',
  scopes: [],
  contentRating: 'g',
};

function makeCtx(host: string, slug = 'cool-app', user?: Record<string, unknown>) {
  return {
    // `canViewNsfw` is what the mature-capable site grants; the viewer's own level is then read
    // from their settings (`getServerBrowsingLevel`).
    features: { appBlocks: true, appBlocksPages: true, canViewNsfw: true },
    ctx: { params: { slug }, req: { headers: { host } } },
    session: user ? { user } : null,
  };
}

// Browsing levels (NsfwLevel bits: PG=1, PG13=2, R=4, X=8). Pairwise distinct.
const viewerWith = (browsingLevel: number) => ({ id: 51, showNsfw: true, browsingLevel });
const X_VIEWER = viewerWith(15);
const R_VIEWER = viewerWith(7);
const PG_VIEWER = viewerWith(1);

async function loadResolver() {
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn;
}

describe('run-page SSR — NSFW-app-red-only gate', () => {
  beforeEach(() => {
    // Only clear the registry/host mocks — NOT capturedResolver. The page module
    // is imported once (ESM module cache), so createServerSideProps runs (and
    // captures the resolver) on the first import only; nulling it here would lose
    // it for every subsequent test.
    mockResolvePageBlockBySlug.mockReset();
  });

  it('SFW (g) app renders on civitai.com', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.com'));
    expect(result).toHaveProperty('props');
    expect(result.props.appBlockId).toBe('ab_1');
  });

  it('SFW (g) app renders on civitai.red too', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.red'));
    expect(result).toHaveProperty('props');
  });

  it('MATURE (x) app 404s on civitai.com', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'x' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.com'));
    expect(result).toEqual({ notFound: true });
  });

  it('MATURE (x) app renders on civitai.red for a viewer with X enabled', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'x' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.red', 'cool-app', X_VIEWER));
    expect(result).toHaveProperty('props');
    expect(result.props.appBlockId).toBe('ab_1');
  });

  it('MATURE (r) app 404s on a missing host header (fail-closed)', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'r' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx(''));
    expect(result).toEqual({ notFound: true });
  });

  it('still 404s a missing app regardless of host (no regression)', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue(null);
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.red'));
    expect(result).toEqual({ notFound: true });
  });
});

/**
 * 🔴 On a mature-capable site an R/X app also needs that rating in the viewer's browsing level.
 * An excluded viewer is NOT given a 404: the page renders a hidden state explaining why — and its
 * props carry nothing of the app but the rating (no name, no iframe, no id).
 */
describe("run-page SSR — R/X apps follow the viewer's browsing level", () => {
  beforeEach(() => {
    mockResolvePageBlockBySlug.mockReset();
  });

  it('🔴 a signed-out viewer on civitai.red gets the hidden state for an R app, and nothing else', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'r' });
    const result = await (await loadResolver())(makeCtx('civitai.red'));
    expect(result).toEqual({
      props: { hiddenByBrowsingLevel: { contentRating: 'r', signedIn: false } },
    });
    const wire = JSON.stringify(result);
    for (const leak of [PAGE.name, PAGE.pageTitle, PAGE.iframeSrc, PAGE.appBlockId, PAGE.appId]) {
      expect(wire).not.toContain(leak);
    }
  });

  it('🔴 a signed-in PG-only viewer gets the hidden state (signed in)', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'r' });
    const result = await (await loadResolver())(makeCtx('civitai.red', 'cool-app', PG_VIEWER));
    expect(result).toEqual({
      props: { hiddenByBrowsingLevel: { contentRating: 'r', signedIn: true } },
    });
  });

  it('an R-enabled viewer runs the R app', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'r' });
    const result = await (await loadResolver())(makeCtx('civitai.red', 'cool-app', R_VIEWER));
    expect(result.props.appBlockId).toBe('ab_1');
    expect(result.props.iframeSrc).toBe(PAGE.iframeSrc);
  });

  it('🔴 X needs X: an R-enabled viewer gets the hidden state for an X app', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'x' });
    const result = await (await loadResolver())(makeCtx('civitai.red', 'cool-app', R_VIEWER));
    expect(result).toEqual({
      props: { hiddenByBrowsingLevel: { contentRating: 'x', signedIn: true } },
    });
  });

  it('a PG-13 app still runs for a PG-only and a signed-out viewer (not gated by the level)', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'pg13' });
    const resolver = await loadResolver();
    expect((await resolver(makeCtx('civitai.red', 'cool-app', PG_VIEWER))).props.appBlockId).toBe(
      'ab_1'
    );
    expect((await resolver(makeCtx('civitai.red'))).props.appBlockId).toBe('ab_1');
  });

  it('off civitai.red an R app is still a plain 404 (the site gate), whatever the level', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'r' });
    const result = await (await loadResolver())(makeCtx('civitai.com', 'cool-app', X_VIEWER));
    expect(result).toEqual({ notFound: true });
  });
});
