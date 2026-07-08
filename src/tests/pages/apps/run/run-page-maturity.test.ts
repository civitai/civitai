import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Real-ish host gate: mature (r/x) requires civitai.red.
vi.mock('~/server/utils/server-domain', () => ({
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

function makeCtx(host: string, slug = 'cool-app') {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    ctx: { params: { slug }, req: { headers: { host } } },
  };
}

async function loadResolver() {
  await import('~/pages/apps/run/[slug]/[[...path]]');
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

  it('MATURE (x) app renders on civitai.red', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'x' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.red'));
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
