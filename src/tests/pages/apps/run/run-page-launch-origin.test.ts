import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget (see the sibling run-page tests this harness is cloned from).
import RunPage from '~/pages/apps/run/[slug]/[[...path]]';

/**
 * BREADCRUMB BY ORIGIN — the run page's half. The My apps home launches with `?from=home`;
 * `getServerSideProps` turns that into the `launchOrigin` prop, and the page hands it to
 * `PageBlockHost` (whose chrome renders "My apps" → /apps instead of "Marketplace" →
 * /apps/store). Pinned here:
 *   1. the resolver reads ONLY the exact value `home`, and keeps the store otherwise;
 *   2. the page forwards it to the host;
 *   3. it never reaches the embedded app: the host's `iframeSrc` is the resolver's
 *      server-built entry URL, unchanged by the page's query.
 * The host side (iframe `src` and BLOCK_INIT carry no `from`) is
 * `PageBlockHostLaunchOrigin.browser.test.tsx`.
 */

const m = vi.hoisted(() => ({
  resolver: null as null | ((c: any) => Promise<any>),
  hostProps: null as null | Record<string, unknown>,
  resolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  recordOpen: vi.fn<(...a: any[]) => Promise<void>>(),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    m.resolver = opts.resolver;
    return async () => ({ props: {} });
  },
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: m.resolvePageBlockBySlug },
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: m.recordOpen,
}));
// "Opening clears the hide" read on a signed-in public launch (its own test:
// run-page-reopen-clears-hide.test.ts). Stubbed so this file never reaches the settings cache.
vi.mock('~/server/services/blocks/my-apps-hidden.service', () => ({
  isMyAppHidden: vi.fn(async () => false),
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  ratingAllowedOnHost: () => true,
}));
vi.mock('@mantine/core', () => ({
  Box: ({ children }: { children?: unknown }) => children ?? null,
  Alert: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({
  useBlockToken: () => ({ token: 't', error: null, missingScopes: [], signedScopes: [] }),
}));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({
  PageBlockHost: (props: Record<string, unknown>) => {
    m.hostProps = props;
    return null;
  },
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

const ENTRY = 'https://cool-app.civit.ai/';
const PAGE = {
  appBlockId: 'ab_1',
  blockId: 'cool-app',
  appId: 'app_1',
  iframeSrc: ENTRY,
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Cool App',
  pageTitle: 'Cool',
  scopes: [],
  contentRating: 'g',
};

function ctxWith(query: Record<string, unknown>) {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    session: { user: { id: 7 } },
    ctx: {
      params: { slug: 'cool-app', path: ['deep', 'view'] },
      query: { slug: 'cool-app', path: ['deep', 'view'], ...query },
      req: { headers: { host: 'civitai.com' } },
      res: {},
    },
  };
}

async function propsFor(query: Record<string, unknown>) {
  if (!m.resolver) throw new Error('resolver not captured');
  const result = await m.resolver(ctxWith(query));
  expect(result, 'the launch must resolve to props (positive control)').toHaveProperty('props');
  return result.props as Record<string, unknown>;
}

beforeEach(() => {
  m.resolvePageBlockBySlug.mockReset().mockResolvedValue({ ...PAGE });
  m.recordOpen.mockReset().mockResolvedValue(undefined);
  m.hostProps = null;
});

describe('/apps/run/[slug] — launch origin', () => {
  it('🔴 `?from=home` → launchOrigin "home"', async () => {
    expect((await propsFor({ from: 'home' })).launchOrigin).toBe('home');
  });

  it.each([
    ['no param', {}],
    ['another value', { from: 'store' }],
    ['a repeated param', { from: ['home', 'home'] }],
    ['garbage', { from: '<script>' }],
  ])('%s → launchOrigin "store"', async (_l, query) => {
    expect((await propsFor(query)).launchOrigin).toBe('store');
  });

  it('🔴 the signal does not touch the entry URL, and the `sl` attribution still works beside it', async () => {
    const sl = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';
    const props = await propsFor({ from: 'home', sl });
    expect(props.iframeSrc).toBe(ENTRY);
    expect(m.recordOpen.mock.calls[0][0]).toMatchObject({ subListingId: sl });
  });

  it('🔴 the page forwards launchOrigin to the host, and the host gets the unchanged entry URL', async () => {
    const props = await propsFor({ from: 'home' });
    renderToStaticMarkup(createElement(RunPage as any, props));
    expect(m.hostProps).not.toBeNull();
    expect(m.hostProps?.launchOrigin).toBe('home');
    expect(m.hostProps?.iframeSrc).toBe(ENTRY);
    // No string the host receives carries the page's query.
    const strings = Object.values(m.hostProps ?? {}).filter(
      (v): v is string => typeof v === 'string'
    );
    expect(strings.length).toBeGreaterThan(0); // positive control: there ARE string props
    expect(strings.filter((v) => v.includes('from='))).toEqual([]);

    m.hostProps = null;
    renderToStaticMarkup(createElement(RunPage as any, await propsFor({})));
    // Read through a widened alias: TS narrowed `m.hostProps` to null at the assignment above.
    const hostAfter = m.hostProps as Record<string, unknown> | null;
    expect(hostAfter?.launchOrigin).toBe('store');
  });
});
