/**
 * The bot HTML cache on the user profile page (`/user/[username]`), rendered as in
 * bot-cache-render.test.ts: Next's own renderer over the REAL `_app`, `_document`, profile page
 * module, its layout and its `getServerSideProps`. The prefetches go to a stand-in for the SSR
 * helpers that answers each procedure with fixed public profile data, since an anonymous profile
 * read is the same for every requester.
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
import type * as FliptClient from '~/server/flipt/client';
import type * as TrpcServerModule from '@trpc/react-query/server';
import { setEnv } from '~/__tests__/mocks/env.mock';

const h = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return { flagOn: true, failPath: null as string | null, bootstrap: vi.fn() };
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

// Wholesale on purpose, as in app-settings-bootstrap.test.ts.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
  resolveShellSeeds: vi.fn(async () => ({})),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSessionModule>()),
  getServerAuthSession: vi.fn(async () => null),
}));

// As in shell-render.test.ts: the client is the inert proxy and the provider is the app's copy.
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

// The SSR helpers: every `ssg.<router>.<procedure>.prefetch/fetch` answers from a real
// QueryClient with fixed public data, or fails for the one path `h.failPath` names.
vi.mock('@trpc/react-query/server', async (importOriginal) => {
  const { QueryClient, dehydrate } = await import('@tanstack/react-query');
  return {
    ...(await importOriginal<typeof TrpcServerModule>()),
    createServerSideHelpers: () => {
      const queryClient = new QueryClient();
      const options = (path: string, input: unknown) => ({
        queryKey: [path.split('.'), { input, type: 'query' }],
        queryFn: async () => {
          if (path === h.failPath) throw new Error(`${path} down`);
          return { path, input, username: 'crawled-creator', id: 7701 };
        },
        retry: false as const,
      });
      const procedure = (path: string) => ({
        prefetch: (input: unknown) => queryClient.prefetchQuery(options(path, input)),
        fetch: (input: unknown) => queryClient.fetchQuery(options(path, input)),
      });
      const router = (name: string) =>
        new Proxy({}, { get: (_, key) => procedure(`${name}.${String(key)}`) });
      return new Proxy(
        {},
        {
          get: (_, key) =>
            key === 'queryClient'
              ? queryClient
              : key === 'dehydrate'
              ? (opts?: Parameters<typeof dehydrate>[1]) => dehydrate(queryClient, opts)
              : router(String(key)),
        }
      );
    },
  };
});

import * as UserPage from '~/pages/user/[username]/index';
import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';
import type { RoutePage, Variant } from './bot-cache-render.harness';
import {
  CRAWLER_A,
  CRAWLER_B,
  CRAWLER_C,
  expectCacheable,
  expectNotCacheable,
  NOW,
  render as renderRoute,
  SECRET,
} from './bot-cache-render.harness';

const USER_PAGE: RoutePage = {
  route: '/user/[username]',
  Component: UserPage.default as never,
  getServerSideProps: UserPage.getServerSideProps,
  params: (path) => ({ username: path.split('/')[2]! }),
};
const render = (variant: Variant = {}) => renderRoute(USER_PAGE, '/user/crawled-creator', variant);

function setFlag(on: boolean) {
  h.flagOn = on;
  resetBotCacheFlagGateForTests();
}

beforeAll(() => {
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  h.failPath = null;
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null, liveNow: false }));
});

describe('/user/[username], flag on', () => {
  it('is cacheable: private to browsers, no cookie, no edge-cache directive', async () => {
    const a = await render(CRAWLER_A);
    expect(a.html).toContain('crawled-creator');
    expectCacheable(a.headers);
  });

  it('three crawlers that differ in agent, IP, country and state: byte-identical, no cookie', async () => {
    const [a, b, c] = [await render(CRAWLER_A), await render(CRAWLER_B), await render(CRAWLER_C)];
    for (const other of [b, c]) {
      expectCacheable(other.headers);
      expect(other.html).toBe(a.html);
    }
    expect(a.pageProps).not.toHaveProperty('region');
    expect(a.pageProps.verifiedBot).toBeNull();
  });

  it('INSTRUMENT CHECK: another profile does change the bytes', async () => {
    const a = await render(CRAWLER_A);
    const other = await render({ url: '/user/someone-else' });
    expect(other.html).not.toBe(a.html);
  });

  it('a failed prefetch (the fail-soft profile read): not cacheable', async () => {
    h.failPath = 'userProfile.overview';
    const a = await render(CRAWLER_A);
    expectNotCacheable(a.headers);
  });
});

describe('/user/[username], flag off', () => {
  it('not cacheable, and the crawlers render different bytes (region)', async () => {
    setFlag(false);
    const a = await render(CRAWLER_A);
    const c = await render(CRAWLER_C);
    expectNotCacheable(a.headers);
    expect(c.pageProps.region).toMatchObject({ countryCode: 'DE' });
    expect(c.html).not.toBe(a.html);
  });
});
