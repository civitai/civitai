/**
 * The static shell of `/images/[imageId]` as Next 16.3.1 actually renders it: Next's own pages
 * renderer (`renderToHTML` in `next/dist/server/render.js`) over the REAL `_app`, `_document` and
 * page module, including the page's `getServerSideProps`. What is compared is the HTML string a
 * browser — and the edge cache — would receive.
 *
 * The shell is one object for every viewer and every URL of the route, so requests that differ in
 * everything a viewer or a URL can vary must produce the same bytes. Session lookups, flag
 * evaluation and the bootstrap are stubbed with values that would be visible in the HTML if they
 * reached it (distinctive ids, a flag that only a per-user or per-request evaluation returns).
 *
 * Lives outside `src/pages`: Next treats every file there as a route.
 */
import { renderToHTML } from 'next/dist/server/render';
import type { ComponentType } from 'react';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as AuthSessionModule from '~/server/auth/get-server-auth-session';
import type * as SearchApiKeyModule from '~/components/Search/search-api-key';
import type * as TrpcModule from '~/utils/trpc';

const SEEDS = vi.hoisted(() => ({
  tosMeta: { hash: 'tos-hash', baseline: 'tos-baseline', fieldKeys: { blue: 'tosBlue' } },
  browsingSettingsAddons: [],
  liveNow: false,
}));

const h = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  authSession: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  // A flag set that shows in the HTML whether it was evaluated per user or per request.
  getFeatureFlagsAsync: vi.fn(async (ctx: { user?: unknown; req?: unknown } = {}) => ({
    shellMaster: true,
    shellImages: true,
    ...(ctx.user ? { perUserFlagLeak: true } : {}),
    ...(ctx.req ? { perRequestFlagLeak: true } : {}),
  })),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: the real module pulls the server
// env schema, the database and redis into the render.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
  resolveShellSeeds: vi.fn(async () => SEEDS),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSessionModule>()),
  getServerAuthSession: h.authSession,
}));

// The real `withTRPC` provides react-query from the copy Node resolves for `@trpc/next`, while the
// app's own `useQueryClient` reads the copy this suite's optimizer bundled, so under Next's renderer
// the two never meet (`No QueryClient set`). A production build has one copy. The shell's server
// render reads no tRPC data, so the client is the inert proxy and the provider is the app's copy.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { createElement, useState } = await import('react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const withTRPC = (AppComponent: ComponentType<object> & { getInitialProps?: unknown }) => {
    const WithQueryClient = (props: object) => {
      const [client] = useState(() => new QueryClient());
      return createElement(QueryClientProvider, { client }, createElement(AppComponent, props));
    };
    WithQueryClient.getInitialProps = AppComponent.getInitialProps;
    return WithQueryClient;
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({}, { withTRPC }),
  };
});

// Next preloads every `dynamic()` module before rendering, and a few build a search client at module
// scope from env this suite does not set.
vi.mock('~/components/Search/search-api-key', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchApiKeyModule>()),
  createInstantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));

import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';
import * as ImagePage from '~/pages/images/[imageId]';
import { PAGE_RENDER_METRIC } from '~/server/prom/route-traffic.metrics';
import { SSR_CPU_METRIC } from '~/server/prom/ssr-cpu.metrics';

const ROUTE = '/images/[imageId]';
const BUILD_ID = 'shell-render-test-build';
// Pinned so the minute-bucketed seed is the same in every render of a case.
const NOW = Date.UTC(2026, 9, 23, 12, 0, 30);

const USERS: Record<string, { id: number; username: string }> = {
  'token-user-a': { id: 424242, username: 'shell-viewer-a' },
  'token-user-b': { id: 535353, username: 'shell-viewer-b' },
};

type Variant = { url: string; headers?: Record<string, string>; cookies?: string };

const BASE_COOKIES = '__Secure-civ-token=token-user-a; civ-shell-images=1';

function makeReq({ url, headers = {}, cookies = BASE_COOKIES }: Variant) {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'civitai.com',
      'cf-ipcountry': 'US',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) ShellTest/1',
      'accept-language': 'en-US',
      cookie: cookies,
      ...headers,
    },
  };
}

function makeRes() {
  const headers = new Map<string, unknown>();
  return {
    statusCode: 200,
    headersSent: false,
    finished: false,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    writeHead: () => undefined,
    end: () => undefined,
  };
}

/** The route query Next hands the renderer for a URL: the dynamic param plus the search params. */
function routeQuery(url: string) {
  const [path, search = ''] = url.split('?');
  const imageId = path!.split('/').pop()!;
  return {
    params: { imageId },
    query: { ...Object.fromEntries(new URLSearchParams(search)), imageId },
  };
}

async function render(variant: Variant) {
  const req = makeReq(variant);
  const res = makeRes();
  const { params, query } = routeQuery(variant.url);
  const result = await renderToHTML(
    req as never,
    res as never,
    ROUTE,
    query,
    {
      Component: ImagePage.default,
      App: AppWithTRPC,
      Document: AppDocument,
      getServerSideProps: ImagePage.getServerSideProps,
      buildManifest: {
        pages: { '/_app': [], [ROUTE]: [] },
        devFiles: [],
        ampDevFiles: [],
        polyfillFiles: [],
        lowPriorityFiles: [],
        rootMainFiles: [],
        ampFirstPages: [],
      },
      reactLoadableManifest: {},
      dynamicCssManifest: [],
      pageConfig: {},
      params,
      resolvedUrl: variant.url,
      page: ROUTE,
      experimental: {},
      isNextDataRequest: false,
    } as never,
    { buildId: BUILD_ID } as never,
    { isFallback: false } as never
  );
  const html = result.toUnchunkedString();
  return { html, headers: res.getHeaders(), nextData: nextDataOf(html) };
}

function nextDataOf(html: string) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  expect(match, 'the render carries __NEXT_DATA__').toBeTruthy();
  return JSON.parse(match![1]!) as {
    page: string;
    query: Record<string, unknown>;
    buildId: string;
    props: { pageProps: Record<string, unknown> };
  };
}

// Top-level `beforeAll` runs before the describe's own, which renders the base case.
beforeAll(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  h.bootstrap.mockImplementation(async () => {
    throw new Error('a shell render must not read the settings bootstrap');
  });
  h.authSession.mockImplementation(async ({ req }: { req: { headers: { cookie?: string } } }) => {
    const token = /civ(?:itai)?-token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = token ? USERS[token] : undefined;
    return user ? { user } : null;
  });
  // The hub's OAuth provider list fails open.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});
afterAll(() => {
  vi.mocked(Date.now).mockRestore();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.bootstrap.mockClear();
  h.authSession.mockClear();
});

const BASE: Variant = { url: '/images/1' };

describe('the /images/[imageId] shell is one object for every viewer and every URL', () => {
  const VARIANTS: [string, Variant][] = [
    ['another viewer', { ...BASE, cookies: '__Secure-civ-token=token-user-b; civ-shell-images=1' }],
    [
      'an invalid session cookie',
      { ...BASE, cookies: '__Secure-civ-token=garbage; civ-shell-images=1' },
    ],
    [
      'the legacy session cookie',
      { ...BASE, cookies: '__Secure-civitai-token=token-user-a; civ-shell-images=1' },
    ],
    [
      'consent, referral and hidden-content cookies',
      {
        ...BASE,
        cookies: `${BASE_COOKIES}; civitai-consent=rejected; ref_code=abc; ref_landing_page=%2Fx; disableHidden=false; apps-rail=collapsed`,
      },
    ],
    [
      'another country and region',
      { ...BASE, headers: { 'cf-ipcountry': 'DE', 'cf-region-code': 'BY' } },
    ],
    ['a non-UK x-isuk header', { ...BASE, headers: { 'x-isuk': '0' } }],
    ['another user agent', { ...BASE, headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Other/2' } }],
    ['another Accept-Language', { ...BASE, headers: { 'accept-language': 'de-DE,de;q=0.9' } }],
    ['an X-Forwarded-Host', { ...BASE, headers: { 'x-forwarded-host': 'elsewhere.example' } }],
    ['another image id', { url: '/images/987654321' }],
    ['another image id with a query', { url: '/images/987654321?postId=5&collectionId=9' }],
  ];

  let base: Awaited<ReturnType<typeof render>>;
  beforeAll(async () => {
    base = await render(BASE);
  });

  it('renders the shell: skeleton, generic noindex head, page-data prefetch, edge headers', () => {
    expect(base.headers['x-civ-render']).toBe('shell');
    expect(base.html).toContain('data-testid="image-detail-shell-skeleton"');
    expect(base.html).toContain('<meta name="robots" content="noindex,nofollow"');
    expect(base.html).toContain('window.__civShell=p');
    expect(base.nextData.page).toBe(ROUTE);
    expect(base.nextData.buildId).toBe(BUILD_ID);
  });

  it('is counted apart from full renders: kind="shell" CPU, authed="shell" renders', async () => {
    const labels = async (name: string) => {
      const metric = instrumentationRegistry.getSingleMetric(name) as client.Counter<string>;
      return (await metric.get()).values.map((v) => v.labels);
    };
    expect(await labels(SSR_CPU_METRIC)).toContainEqual(
      expect.objectContaining({ phase: 'render', kind: 'shell' })
    );
    expect(await labels(PAGE_RENDER_METRIC)).toContainEqual(
      expect.objectContaining({ authed: 'shell' })
    );
  });

  it.each(VARIANTS)('byte-identical for %s', async (_, variant) => {
    const other = await render(variant);
    expect(other.headers['x-civ-render']).toBe('shell');
    expect(other.html).toBe(base.html);
  });

  it('carries no route query, page data, session or viewer in its bytes', async () => {
    const withId = await render({ url: '/images/987654321?postId=5' });
    expect(withId.nextData.query).toEqual({});
    for (const leak of [
      '987654321',
      'trpcState',
      'token-user-a',
      '424242',
      'shell-viewer-a',
      'perUserFlagLeak',
      'perRequestFlagLeak',
      'civ-shell-images',
      'ShellTest',
    ]) {
      expect(withId.html, leak).not.toContain(leak);
    }
    expect(withId.nextData.props.pageProps).not.toHaveProperty('session');
    expect(h.authSession).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it('INSTRUMENT CHECK: the one viewer value the shell carries (colour scheme) does change the bytes', async () => {
    const light = await render({ ...BASE, cookies: `${BASE_COOKIES}; mantine-color-scheme=light` });
    expect(light.headers['x-civ-render']).toBe('shell');
    expect(light.html).not.toBe(base.html);
  });

  it('hands the client exactly the reviewed pageProps', () => {
    expect(Object.keys(base.nextData.props.pageProps).sort()).toEqual(
      [
        'adsGated',
        'availableOAuthProviders',
        'browsingSettingsAddons',
        'canIndex',
        'colorScheme',
        'cookies',
        'domain',
        'flags',
        'hasAuthCookie',
        'host',
        'liveNow',
        'seed',
        'serverDomains',
        'shell',
        'tosMeta',
        'verifiedBot',
      ].sort()
    );
    expect(base.nextData.props.pageProps).toMatchObject({
      shell: true,
      adsGated: true,
      hasAuthCookie: true,
      verifiedBot: null,
      seed: Math.floor(NOW / 60_000) * 60_000,
      liveNow: false,
      tosMeta: SEEDS.tosMeta,
      flags: { shellMaster: true, shellImages: true },
    });
  });
});
