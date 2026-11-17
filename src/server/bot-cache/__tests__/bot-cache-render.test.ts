/**
 * The bot HTML cache as Next 16 actually renders a page: Next's own pages renderer
 * (`renderToHTML` in `next/dist/server/render.js`) over the REAL `_app`, `_document` and
 * `/images/[imageId]` page module, including its `getServerSideProps` (only the page body and its
 * data resolver are stubbed). What is compared is the HTML string the cache would store.
 *
 * A cacheable render is served to every crawler that asks for the URL, so two cookie-less
 * crawler requests that differ in everything a requester varies (user agent, IP, country, state)
 * must produce the same bytes and set no cookie. Off the flag, nothing may change.
 *
 * Lives outside `src/pages`: Next treats every file there as a route.
 */
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
import type * as ShellResponse from '~/server/shell/shell-response';
import type { QueryClient } from '@tanstack/react-query';
import { NextRequest } from 'next/server';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BOT_CACHE_REQ_KEY } from '~/shared/constants/bot-cache.constants';

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

// The origin cache stores nothing without a real build id, and a test has no `.next/BUILD_ID`.
vi.mock('~/server/shell/shell-response', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellResponse>()),
  shellBuildId: () => 'bot-cache-render-test-build',
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

import * as ImagePage from '~/pages/images/[imageId]';
import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';
import { botCacheMiddleware } from '~/server/middleware/bot-cache.middleware';
import { runMiddlewares } from '~/server/middleware/index';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import type { RoutePage, Variant } from './bot-cache-render.harness';
import {
  CRAWLER_A,
  CRAWLER_B,
  CRAWLER_C,
  expectCacheable,
  expectNotCacheable,
  makeReq,
  makeRes,
  NOW,
  render as renderRoute,
  renderPage,
  SECRET,
} from './bot-cache-render.harness';

const IMAGE_PAGE: RoutePage = {
  route: '/images/[imageId]',
  Component: ImagePage.default as never,
  getServerSideProps: ImagePage.getServerSideProps,
  params: (path) => ({ imageId: path.split('/').pop()! }),
};
const render = (variant: Variant = {}) => renderRoute(IMAGE_PAGE, '/images/1', variant);

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

/** What the bot-detection middleware adds for an IP-verified Googlebot on this path. */
const GOOGLEBOT: Variant = { headers: { 'x-civitai-verified-bot': 'googlebot' } };

describe('flag on: a cacheable render is one object for every crawler', () => {
  it('is private to browsers, sets no cookie, and carries no edge-cache directive', async () => {
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    // Names are stored lowercased, as Node does: this covers `Cloudflare-CDN-Cache-Control` and
    // `Cache-Tag` as sent.
    expectCacheable(a.headers);
  });

  it.each([
    ['the IP-verified Googlebot', GOOGLEBOT],
    ['another crawler, IP, US state and language', CRAWLER_B],
    ['another crawler, IP, country and region', CRAWLER_C],
  ])('byte-identical HTML for %s, and no cookie', async (_, variant) => {
    const a = await render(CRAWLER_A);
    const other = await render(variant);
    expectCacheable(other.headers);
    expect(other.html).toBe(a.html);
  });

  it('carries no region, a per-URL seed, no verifiedBot and region-free flags', async () => {
    const { pageProps } = await render({ headers: { ...CRAWLER_B.headers, ...GOOGLEBOT.headers } });
    expect(pageProps).not.toHaveProperty('region');
    expect(pageProps.verifiedBot).toBeNull();
    expect(pageProps.seed).not.toBe(NOW);
    expect(pageProps.flags).not.toHaveProperty('perRequestFlagLeak');
  });

  it('INSTRUMENT CHECK: another URL does change the bytes', async () => {
    const a = await render(CRAWLER_A);
    const other = await render({ url: '/images/987654321' });
    expectCacheable(other.headers);
    expect(other.html).not.toBe(a.html);
  });
});

describe('flag off: nothing changes', () => {
  it('not cacheable, and the render keeps its per-request region, seed and verifiedBot', async () => {
    setFlag(false);
    const b = await render({ headers: { ...CRAWLER_B.headers, ...GOOGLEBOT.headers } });
    expectNotCacheable(b.headers);
    expect(b.pageProps.region).toMatchObject({ countryCode: 'US', regionCode: 'CA' });
    expect(b.pageProps.seed).toBe(NOW);
    expect(b.pageProps.verifiedBot).toBe('googlebot');
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
  it('a failed prefetch: not cacheable', async () => {
    h.failPrefetch = true;
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    expectNotCacheable(a.headers);
  });

  it('a degraded settings bootstrap: not cacheable', async () => {
    h.bootstrap.mockImplementation(async () => {
      throw new Error('bootstrap down');
    });
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('data-testid="bot-cache-page"');
    expectNotCacheable(a.headers);
  });

  it('a request without the edge secret: not cacheable, and the ordinary render', async () => {
    const a = await render({ headers: { 'x-civ-cf-verified-bot': 'guess' } });
    expectNotCacheable(a.headers);
    expect(a.pageProps.verifiedBot).toBeNull();
    expect(a.pageProps.region).toMatchObject({ countryCode: 'US' });
  });

  it('civitai.red: not cacheable', async () => {
    const a = await render({ headers: { host: 'civitai.red' } });
    expectNotCacheable(a.headers);
  });

  it('a page that throws: the error page carries none of the edge-cache headers', async () => {
    const req = makeReq('/images/1', CRAWLER_A);
    const res = makeRes();
    h.throwInPage = true;
    let thrown: unknown;
    try {
      await renderPage(IMAGE_PAGE, req, res);
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
    // A shell attempt can leave the edge headers on the response: only `_app` takes them off again.
    res.setHeader('Cloudflare-CDN-Cache-Control', 'public, max-age=300');
    res.setHeader('Cache-Tag', 'botcache,botcache-images,build-x');
    const marks = req as unknown as Record<string, unknown>;
    expect(marks[BOT_CACHE_REQ_KEY], 'precondition: the failed run was marked').toBe('images');
    for (const name of ['cloudflare-cdn-cache-control', 'cache-tag'])
      expect(res.getHeaders(), `precondition: ${name}`).toHaveProperty(name);
    await renderPage(IMAGE_PAGE, req, res, thrown as Error);
    const headers = res.getHeaders();
    for (const name of ['cloudflare-cdn-cache-control', 'cache-tag'])
      expect(headers, name).not.toHaveProperty(name);
    expect(marks[BOT_CACHE_REQ_KEY]).toBeUndefined();
  });
});

describe('flag evaluation', () => {
  const calls = () => vi.mocked(getFeatureFlagsAsync).mock.calls.map(([ctx]) => ctx);
  const theRequest = expect.objectContaining({ url: '/images/1', method: 'GET' });

  it('a marked request: neither `_app` nor the page hands the evaluation the request', async () => {
    vi.mocked(getFeatureFlagsAsync).mockClear();
    const a = await render(CRAWLER_A);
    expectCacheable(a.headers);
    expect(calls()).toEqual([
      { user: undefined, host: 'civitai.com', req: undefined },
      { user: undefined, host: 'civitai.com', req: undefined },
    ]);
  });

  it('INSTRUMENT CHECK: an unmarked request hands both evaluations the request', async () => {
    setFlag(false);
    vi.mocked(getFeatureFlagsAsync).mockClear();
    await render(CRAWLER_A);
    expect(calls()).toEqual([
      { user: undefined, host: 'civitai.com', req: theRequest },
      { user: undefined, req: theRequest },
    ]);
  });
});

describe('origin cache: a stored render is served to the next crawler', () => {
  const stored = new Map<string, unknown>();

  beforeEach(() => {
    stored.clear();
    redisMock.redis.packed.set.mockReset();
    redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
      stored.set(key, value);
      return 'OK';
    });
    redisMock.redis.packed.get.mockReset();
    redisMock.redis.packed.get.mockImplementation(async (key: string) => stored.get(key) ?? null);
  });

  const proxy = (url: string, variant: Variant = CRAWLER_A) => {
    const req = makeReq(url, variant);
    const request = new NextRequest(`https://${req.headers.host}${req.url}`, {
      headers: req.headers,
    });
    return runMiddlewares(request, [botCacheMiddleware]);
  };

  /** A render, then what Next's `sendRenderResult` does with it (`send-payload.js`, 16.4.5). */
  async function renderAndSend(url: string, variant: Variant = CRAWLER_A) {
    const res = makeRes();
    const html = await renderPage(IMAGE_PAGE, makeReq(url, variant), res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    // The harness types `end` without arguments; the capture `_document` installs takes Next's.
    (res.end as (chunk: string) => void).call(res, html);
    return { html, res };
  }

  const storedPaths = () => [...stored.keys()].map((key) => key.split(':').pop());

  it('the first request renders and stores; the second is served the same bytes', async () => {
    const first = await proxy('/images/1');
    expect(first.headers.get('x-civ-bot-cache')).toBe('miss');
    const { html, res } = await renderAndSend('/images/1');
    await vi.waitFor(() => expect(stored.size).toBe(1));

    const second = await proxy('/images/1');
    expect(second.headers.get('x-civ-bot-cache')).toBe('hit');
    expect(await second.text()).toBe(html);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(second.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
    expect(second.headers.get('Cache-Tag')).toBeNull();
    expectCacheable(res.getHeaders());
  });

  it.each<[string, () => void]>([
    [
      'a failed prefetch',
      () => {
        h.failPrefetch = true;
      },
    ],
    [
      'a degraded settings bootstrap',
      () => {
        h.bootstrap.mockImplementation(async () => {
          throw new Error('bootstrap down');
        });
      },
    ],
  ])('%s is not stored', async (_, breakRender) => {
    breakRender();
    const broken = await renderAndSend('/images/1');
    expect(broken.html).toContain('data-testid="bot-cache-page"');
    h.failPrefetch = false;
    h.bootstrap.mockImplementation(async () => ({ session: null, liveNow: false }));
    // INSTRUMENT CHECK: a healthy render sent after it is stored, by the same path.
    await renderAndSend('/images/2');
    await vi.waitFor(() => expect(storedPaths()).toContain('/images/2?'));
    expect(storedPaths()).toEqual(['/images/2?']);
    expect((await proxy('/images/1')).headers.get('x-civ-bot-cache')).toBe('miss');
  });
});
