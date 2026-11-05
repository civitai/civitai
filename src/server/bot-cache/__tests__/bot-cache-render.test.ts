/**
 * The bot HTML edge cache as Next 16 actually renders a page: Next's own pages renderer
 * (`renderToHTML` in `next/dist/server/render.js`) over the REAL `_app`, `_document` and
 * `/images/[imageId]` page module, including its `getServerSideProps` (only the page body and its
 * data resolver are stubbed). What is compared is the HTML string the edge would store.
 *
 * An edge-cacheable render is served to every crawler that asks for the URL, so two cookie-less
 * crawler requests that differ in everything a requester varies (user agent, IP, country, state)
 * must produce the same bytes and set no cookie. Off the flag, nothing may change.
 *
 * Lives outside `src/pages`: Next treats every file there as a route.
 */
import { renderToHTML } from 'next/dist/server/render';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as AuthSessionModule from '~/server/auth/get-server-auth-session';
import type * as SearchApiKeyModule from '~/components/Search/search-api-key';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailPageModule from '~/components/Image/Detail/ImageDetailPage';
import type * as ImageDetailDataModule from '~/server/page-data/image-detail';
import type * as FliptClient from '~/server/flipt/client';
import type { QueryClient } from '@tanstack/react-query';
import { setEnv } from '~/__tests__/mocks/env.mock';

const h = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return {
    flagOn: true,
    failPrefetch: false,
    throwInPage: false,
    bootstrap: vi.fn(),
  };
});

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => ({})),
  isFliptSync: vi.fn((key: string) => (key === 'bot-html-edge-cache' && h.flagOn ? true : null)),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  // A flag that reaches the HTML only when the evaluation was handed the request (and its region).
  getFeatureFlagsAsync: vi.fn(async (ctx: { req?: unknown } = {}) => ({
    ...(ctx.req ? { perRequestFlagLeak: true } : {}),
  })),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: the real module pulls the server
// env schema, the database and redis into the render.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
  resolveShellSeeds: vi.fn(async () => ({})),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSessionModule>()),
  getServerAuthSession: vi.fn(async () => null),
}));

// As in shell-render.test.ts: under Next's renderer the app's react-query copy and `@trpc/next`'s
// never meet, so the client is the inert proxy and the provider is the app's copy.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { useState } = await import('react');
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

vi.mock('~/components/Search/search-api-key', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchApiKeyModule>()),
  createInstantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));

vi.mock('~/components/Image/Detail/ImageDetailPage', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailPageModule>()),
  ImageDetailPage: () => {
    if (h.throwInPage) throw new Error('page render failed');
    return createElement('main', { 'data-testid': 'bot-cache-page' }, 'image page');
  },
}));

// The page's data: one prefetch that succeeds, and, on demand, one that fails soft (as the real
// resolver's `.catch(() => null)` prefetches do).
vi.mock('~/server/page-data/image-detail', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailDataModule>()),
  resolveImageDetailPageData: vi.fn(
    async ({
      ssg,
      ctx,
    }: {
      ssg?: { queryClient: QueryClient };
      ctx: { params?: { imageId?: string } };
    }) => {
      const id = Number(ctx.params?.imageId);
      await ssg?.queryClient.prefetchQuery({
        queryKey: ['bot-cache-image', id],
        queryFn: async () => ({ id, title: `image ${id}` }),
        retry: false,
      });
      if (h.failPrefetch) {
        await ssg?.queryClient.prefetchQuery({
          queryKey: ['bot-cache-related', id],
          queryFn: async () => {
            throw new Error('related down');
          },
          retry: false,
        });
      }
      return { props: { id } };
    }
  ),
}));

import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';
import * as ImagePage from '~/pages/images/[imageId]';
import ErrorPage from '~/pages/_error';
import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';

const ROUTE = '/images/[imageId]';
const BUILD_ID = 'bot-cache-render-test-build';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 30);
const SECRET = 'bot-cache-render-secret-91c2';

type Variant = { url?: string; headers?: Record<string, string> };

/** A cookie-less crawler request as the edge forwards it (no `cookie` header at all). */
function makeReq({ url = '/images/1', headers = {} }: Variant = {}) {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'civitai.com',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'cf-connecting-ip': '66.249.66.1',
      'x-forwarded-for': '66.249.66.1',
      'cf-ipcountry': 'US',
      'accept-language': 'en-US',
      'x-civ-cf-verified-bot': SECRET,
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

type Req = ReturnType<typeof makeReq>;
type Res = ReturnType<typeof makeRes>;

function routeQuery(url: string) {
  const [path, search = ''] = url.split('?');
  const imageId = path!.split('/').pop()!;
  return {
    params: { imageId },
    query: { ...Object.fromEntries(new URLSearchParams(search)), imageId },
  };
}

/** One `renderToHTML` of `/images/[imageId]`, or of `/_error` with `err` as Next renders it. */
async function renderPage(req: Req, res: Res, url: string, err?: Error) {
  const { params, query } = routeQuery(url);
  const page = err ? '/_error' : ROUTE;
  const result = await renderToHTML(
    req as never,
    res as never,
    page,
    err ? {} : query,
    {
      Component: err ? ErrorPage : ImagePage.default,
      App: AppWithTRPC,
      Document: AppDocument,
      getServerSideProps: err ? undefined : ImagePage.getServerSideProps,
      err,
      buildManifest: {
        pages: { '/_app': [], [ROUTE]: [], '/_error': [] },
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
      params: err ? undefined : params,
      resolvedUrl: url,
      page,
      experimental: {},
      isNextDataRequest: false,
    } as never,
    { buildId: BUILD_ID } as never,
    { isFallback: false } as never
  );
  return result.toUnchunkedString();
}

function nextDataOf(html: string) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  expect(match, 'the render carries __NEXT_DATA__').toBeTruthy();
  return JSON.parse(match![1]!) as { props: { pageProps: Record<string, unknown> } };
}

async function render(variant: Variant = {}) {
  const req = makeReq(variant);
  const res = makeRes();
  const html = await renderPage(req, res, req.url);
  return { html, headers: res.getHeaders(), pageProps: nextDataOf(html).props.pageProps };
}

function setFlag(on: boolean) {
  h.flagOn = on;
  resetBotCacheFlagGateForTests();
}

beforeAll(() => {
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  setFlag(true);
  h.failPrefetch = false;
  h.throwInPage = false;
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null, liveNow: false }));
});

/** Two crawlers that differ in every requester fact: agent, IP, country, state. */
const CRAWLER_A: Variant = {};
const CRAWLER_B: Variant = {
  headers: {
    'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'cf-connecting-ip': '157.55.39.1',
    'x-forwarded-for': '157.55.39.1',
    'cf-ipcountry': 'US',
    'cf-region-code': 'CA',
    'accept-language': 'de-DE,de;q=0.9',
  },
};
const CRAWLER_C: Variant = {
  headers: {
    'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Applebot/0.1',
    'cf-connecting-ip': '17.58.101.1',
    'x-forwarded-for': '17.58.101.1',
    'cf-ipcountry': 'DE',
    'cf-region-code': 'BY',
  },
};

describe('flag on: an edge-cacheable render is one object for every crawler', () => {
  it('is edge-cacheable for 6 h, private to browsers, tagged, and sets no cookie', async () => {
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    expect(a.headers['cloudflare-cdn-cache-control']).toBe('public, max-age=21600');
    expect(a.headers['cache-control']).toBe('private, no-store');
    expect(a.headers['cache-tag']).toMatch(/^botcache,botcache-images,build-[\w-]+$/);
    expect(a.headers).not.toHaveProperty('set-cookie');
  });

  it.each([
    ['another crawler, IP, US state and language', CRAWLER_B],
    ['another crawler, IP, country and region', CRAWLER_C],
  ])('byte-identical HTML for %s, and no cookie', async (_, variant) => {
    const a = await render(CRAWLER_A);
    const other = await render(variant);
    expect(other.headers['cloudflare-cdn-cache-control']).toBe('public, max-age=21600');
    expect(other.headers).not.toHaveProperty('set-cookie');
    expect(other.html).toBe(a.html);
  });

  it('carries no region, a per-URL seed, one verifiedBot value and region-free flags', async () => {
    const { pageProps } = await render(CRAWLER_B);
    expect(pageProps).not.toHaveProperty('region');
    expect(pageProps.verifiedBot).toBe('edge-crawler');
    expect(pageProps.seed).not.toBe(NOW);
    expect(pageProps.flags).not.toHaveProperty('perRequestFlagLeak');
  });

  it('INSTRUMENT CHECK: another URL does change the bytes', async () => {
    const a = await render(CRAWLER_A);
    const other = await render({ url: '/images/987654321' });
    expect(other.headers['cloudflare-cdn-cache-control']).toBe('public, max-age=21600');
    expect(other.html).not.toBe(a.html);
  });
});

describe('flag off: nothing changes', () => {
  it('no edge-cache header, and the render keeps its per-request region, seed and verifiedBot', async () => {
    setFlag(false);
    const b = await render(CRAWLER_B);
    for (const name of ['cloudflare-cdn-cache-control', 'cache-tag'])
      expect(b.headers, name).not.toHaveProperty(name);
    expect(b.pageProps.region).toMatchObject({ countryCode: 'US', regionCode: 'CA' });
    expect(b.pageProps.seed).toBe(NOW);
    expect(b.pageProps.verifiedBot).toBeNull();
    expect(b.pageProps.flags).toHaveProperty('perRequestFlagLeak', true);
  });

  it('INSTRUMENT CHECK: the same two crawlers then render different bytes', async () => {
    setFlag(false);
    const a = await render(CRAWLER_A);
    const c = await render(CRAWLER_C);
    expect(c.html).not.toBe(a.html);
  });
});

describe('a render that must not be stored', () => {
  it('a failed prefetch: no edge-cache header', async () => {
    h.failPrefetch = true;
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    expect(a.headers).not.toHaveProperty('cloudflare-cdn-cache-control');
    expect(a.headers).not.toHaveProperty('cache-tag');
  });

  it('a degraded settings bootstrap: no edge-cache header', async () => {
    h.bootstrap.mockImplementation(async () => {
      throw new Error('bootstrap down');
    });
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    expect(a.headers).not.toHaveProperty('cloudflare-cdn-cache-control');
  });

  it('a request without the edge secret: no edge-cache header, and the ordinary render', async () => {
    const a = await render({ headers: { 'x-civ-cf-verified-bot': 'guess' } });
    expect(a.headers).not.toHaveProperty('cloudflare-cdn-cache-control');
    expect(a.pageProps.verifiedBot).toBeNull();
    expect(a.pageProps.region).toMatchObject({ countryCode: 'US' });
  });

  it('civitai.red: no edge-cache header', async () => {
    const a = await render({ headers: { host: 'civitai.red' } });
    expect(a.headers).not.toHaveProperty('cloudflare-cdn-cache-control');
  });

  it('a page that throws: the error page carries none of the edge-cache headers', async () => {
    const req = makeReq(CRAWLER_A);
    const res = makeRes();
    h.throwInPage = true;
    let thrown: unknown;
    try {
      await renderPage(req, res, req.url);
    } catch (e) {
      thrown = e;
    } finally {
      h.throwInPage = false;
    }
    expect(String(thrown)).toContain('page render failed');
    // What Next's base server does next with the same request and response: reset Cache-Control,
    // then render `/_error`.
    res.statusCode = 500;
    res.setHeader('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
    await renderPage(req, res, req.url, thrown as Error);
    const headers = res.getHeaders();
    for (const name of ['cloudflare-cdn-cache-control', 'cache-tag'])
      expect(headers, name).not.toHaveProperty(name);
  });
});
