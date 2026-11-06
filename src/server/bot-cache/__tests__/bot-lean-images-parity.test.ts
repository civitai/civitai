/**
 * Content parity for the bot lean render of `/images/[imageId]` (`~/server/bot-cache/bot-lean`):
 * the SAME request for the same image is rendered twice through Next's own pages renderer
 * (`renderToHTML`) over the REAL `_app`, `_document`, page module, resolver and image detail tree —
 * once with `bot-lean-render` off (the full React render) and once on (the lean page) — and what a
 * crawler reads from each is compared: title, the SEO `<meta>`s (description, robots, Open Graph,
 * Twitter), canonical, the JSON-LD (parsed, deep-equal), the visible text (whitespace collapsed),
 * every body `<img>` (src/alt/width/height/srcset), every link, and the HTTP status.
 *
 * A difference here is cloaking: crawlers would be served a page people do not get.
 *
 * What is real and what is not:
 * - The tRPC router is a stand-in answering the page's four prefetches from the fixture, so the
 *   resolver, the SSG helpers, the query cache and `dehydrate` are the real ones, and both renders
 *   read the same cache.
 * - The React tree's `trpc` hooks run on a REAL React Query client hydrated from the render's own
 *   `trpcState`, as the patched `withTRPC` does, so a query the page did not prefetch is pending on
 *   the server exactly as in production (loaders, not data), and an errored prefetch is absent.
 * - Feature flags are the real `getFeatureFlagsAsync` for the green host, with every Flipt-backed
 *   flag unset except the two this path reads.
 *
 * Every lean-eligible fixture is also checked to have BEEN lean (no `__NEXT_DATA__`, counter
 * `render`), and every other one to have fallen back (counter `fallback` with its reason), so a
 * parity pass can never be two full renders compared with each other.
 *
 * Lives outside `src/pages`: Next treats every file there as a route.
 */
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthSessionModule from '~/server/auth/get-server-auth-session';
import type * as SearchApiKeyModule from '~/components/Search/search-api-key';
import type * as TrpcModule from '~/utils/trpc';
import type * as FliptClient from '~/server/flipt/client';
import type * as ShellResponse from '~/server/shell/shell-response';
import type * as RoutersModule from '~/server/routers';
import type * as LoggingClient from '~/server/logging/client';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { Fixture } from './bot-lean-images.fixtures';

const h = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return {
    leanOn: false,
    fixture: undefined as unknown as Fixture,
    bootstrap: vi.fn(),
    logged: [] as Record<string, unknown>[],
  };
});

// The lean path swallows its errors (and falls back); keep what it logs, so a test can say why.
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: vi.fn(async (data: Record<string, unknown>) => void h.logged.push(data)),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => ({})),
  isFliptSync: vi.fn((key: string) => {
    if (key === 'bot-html-edge-cache') return true;
    if (key === 'bot-lean-render') return h.leanOn;
    return null;
  }),
}));

// The origin cache keys on a real build id, and a test has no `.next/BUILD_ID`.
vi.mock('~/server/shell/shell-response', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellResponse>()),
  shellBuildId: () => 'bot-lean-parity-test-build',
}));

// Wholesale, as in bot-cache-render.test.ts: the real module pulls the database and redis in.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
  resolveShellSeeds: vi.fn(async () => ({})),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSessionModule>()),
  getServerAuthSession: vi.fn(async () => null),
}));

vi.mock('~/components/Search/search-api-key', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchApiKeyModule>()),
  createInstantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));

// The page's four prefetches, answered from the fixture; everything else about the SSG helpers
// (`createServerSideHelpers`, its query cache, `dehydrate`) is real.
vi.mock('~/server/routers', async (importOriginal) => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC.create();
  const answer = (value: unknown) => {
    if (value === undefined) throw new TRPCError({ code: 'NOT_FOUND' });
    return value;
  };
  const appRouter = t.router({
    image: t.router({
      get: t.procedure
        .input((v) => v as { id: number })
        .query(() => answer(h.fixture.image ?? undefined)),
      getGenerationData: t.procedure
        .input((v) => v as { id: number })
        .query(() => answer(h.fixture.generationData)),
      getContestCollectionDetails: t.procedure
        .input((v) => v as { id: number })
        .query(() => answer(undefined)),
    }),
    hiddenPreferences: t.router({
      getHidden: t.procedure.query(() => answer(h.fixture.hidden)),
    }),
  });
  return { ...(await importOriginal<typeof RoutersModule>()), appRouter };
});

// The React tree's tRPC client: every `useQuery`/`useInfiniteQuery` is React Query's own, on a
// client hydrated from the page's `trpcState` (what the patched `withTRPC` does), keyed exactly as
// tRPC keys it, with a query function that never settles — a server render never fetches.
// Mutations, `useUtils` and `useQueries` are the inert proxy's (`test/trpcProxyStub`).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { useState } = await import('react');
  const RQ = await import('@tanstack/react-query');
  const { unionDeserialize } = await import('~/shared/utils/trpc-union-transformer');

  const withTRPC = (AppComponent: ComponentType<object> & { getInitialProps?: unknown }) => {
    const WithQueryClient = (props: { pageProps?: { trpcState?: unknown } }) => {
      const [client] = useState(() => {
        const queryClient = new RQ.QueryClient();
        const state = props.pageProps?.trpcState;
        if (state !== undefined) RQ.hydrate(queryClient, unionDeserialize(state));
        return queryClient;
      });
      return createElement(
        RQ.QueryClientProvider,
        { client },
        createElement(AppComponent, props as object)
      );
    };
    WithQueryClient.getInitialProps = AppComponent.getInitialProps;
    return WithQueryClient;
  };
  const base = makeTrpcProxy({}, { withTRPC }) as Record<string, unknown>;
  const never = () => new Promise<never>(() => undefined);
  // `getQueryKeyInternal` in @trpc/react-query, for the `query` and `infinite` types.
  const keyOf = (path: string[], input: unknown, type: 'query' | 'infinite') => {
    let keyInput = input;
    if (type === 'infinite' && input && typeof input === 'object') {
      const { cursor: _c, direction: _d, ...rest } = input as Record<string, unknown>;
      keyInput = rest;
    }
    return [path, { ...(keyInput !== undefined ? { input: keyInput } : {}), type }];
  };
  type Opts = Record<string, unknown> & { trpc?: unknown; initialCursor?: unknown };
  const inert = (base.image as Record<string, Record<string, unknown>>).get;
  const node = (path: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, key: string) {
          if (key === 'then') return undefined;
          if (key === 'useQuery')
            return (input: unknown, { trpc: _trpc, ...rest }: Opts = {}) =>
              RQ.useQuery({ queryKey: keyOf(path, input, 'query'), queryFn: never, ...rest });
          if (key === 'useInfiniteQuery')
            return (input: unknown, { trpc: _trpc, initialCursor, ...rest }: Opts = {}) =>
              RQ.useInfiniteQuery({
                queryKey: keyOf(path, input, 'infinite'),
                queryFn: never,
                initialPageParam: initialCursor ?? null,
                getNextPageParam: () => undefined,
                ...rest,
              } as never);
          if (key === 'useMutation' || key === 'useSuspenseQuery') return inert[key];
          return node([...path, key]);
        },
      }
    );
  const trpc = new Proxy(base, {
    get(target, key: string) {
      if (key === 'then') return undefined;
      if (['useUtils', 'useContext', 'useQueries', 'withTRPC'].includes(key)) return target[key];
      return node([key]);
    },
  });
  return { ...(await importOriginal<typeof TrpcModule>()), trpc };
});

import * as ImagePage from '~/pages/images/[imageId]';
import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';
import { BOT_LEAN_RENDER_METRIC, resetBotLeanFlagGateForTests } from '~/server/bot-cache/bot-lean';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type { RoutePage } from './bot-cache-render.harness';
import { makeReq, NOW, renderPage, SECRET } from './bot-cache-render.harness';
import { extractSeo, seoOf } from './bot-lean-seo';
import { FIXTURES } from './bot-lean-images.fixtures';

const IMAGE_PAGE: RoutePage = {
  route: '/images/[imageId]',
  Component: ImagePage.default as never,
  getServerSideProps: ImagePage.getServerSideProps,
  params: (path) => ({ imageId: path.split('/').pop()! }),
};

/** The harness response, plus a body: the lean page is sent with `res.end`, as Next would. */
function makeSendingRes() {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    headersSent: false,
    finished: false,
    body: undefined as string | undefined,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    writeHead: () => undefined,
    write: () => true,
    end(chunk?: string) {
      if (typeof chunk === 'string') res.body = chunk;
      res.headersSent = true;
      res.finished = true;
    },
  };
  return res;
}

async function leanCount(event: string, reason: string) {
  const metric = instrumentationRegistry.getSingleMetric(BOT_LEAN_RENDER_METRIC);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => v.labels.event === event && v.labels.reason === reason)
    .reduce((sum, v) => sum + v.value, 0);
}

function setLean(on: boolean) {
  h.leanOn = on;
  resetBotLeanFlagGateForTests();
}

async function renderImage(fixture: Fixture, lean: boolean) {
  h.fixture = fixture;
  setLean(lean);
  const req = makeReq(`/images/${fixture.id}`);
  const res = makeSendingRes();
  const returned = await renderPage(IMAGE_PAGE, req as never, res as never);
  const html = res.body ?? returned;
  return { html, status: res.statusCode, headers: res.getHeaders() };
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
  h.logged.length = 0;
  resetBotCacheFlagGateForTests();
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null, liveNow: false }));
});

describe('bot lean render of /images/[imageId]: what a crawler reads is the full render', () => {
  it.each(FIXTURES.map((f) => [f.label, f] as const))('%s', async (_, fixture) => {
    const full = await renderImage(fixture, false);
    expect(extractSeo(full.html).hasNextData, 'the flag-off render is the full one').toBe(true);

    const [event, reason] =
      fixture.expect === 'lean' ? ['render', ''] : ['fallback', fixture.expect as string];
    const before = await leanCount(event, reason);
    const lean = await renderImage(fixture, true);
    const after = await leanCount(event, reason);

    // Positive control: the flag-on render took the path the fixture says it does.
    const failures = h.logged.filter((entry) => entry.name === 'bot-lean-render');
    expect.soft(failures, 'the lean path logged no failure').toEqual([]);
    expect.soft(after - before, `counter for ${fixture.expect}`).toBe(1);
    expect(extractSeo(lean.html).hasNextData, 'the flag-on render is lean').toBe(
      fixture.expect !== 'lean'
    );

    expect.soft(lean.status, 'status').toBe(full.status);
    expect.soft(lean.headers['x-robots-tag'], 'X-Robots-Tag').toEqual(full.headers['x-robots-tag']);
    // One assertion per field, so a run names every field that differs.
    const fullSeo = seoOf(full.html);
    const leanSeo = seoOf(lean.html);
    for (const field of Object.keys(fullSeo) as (keyof typeof fullSeo)[])
      expect.soft(leanSeo[field], field).toEqual(fullSeo[field]);
  });
});

describe('the lean page', () => {
  it('is private to browsers and sets no cookie', async () => {
    const fixture = FIXTURES.find((f) => f.expect === 'lean')!;
    const lean = await renderImage(fixture, true);
    expect(lean.headers['cache-control']).toBe('private, no-store');
    expect(lean.headers).not.toHaveProperty('set-cookie');
    expect(lean.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('INSTRUMENT CHECK: the extract tells two different images apart', async () => {
    const [a, b] = FIXTURES.filter((f) => f.expect === 'lean');
    const one = await renderImage(a!, false);
    const two = await renderImage(b!, false);
    expect(seoOf(two.html)).not.toEqual(seoOf(one.html));
  });

  it('INSTRUMENT CHECK: the full render carries the content the extract compares', async () => {
    const fixture = FIXTURES.find((f) => f.label.startsWith('resources'))!;
    const seo = seoOf((await renderImage(fixture, false)).html);
    expect(seo.title.length).toBeGreaterThan(0);
    expect(seo.canonical.length).toBe(1);
    expect(seo.jsonLd.length).toBeGreaterThan(0);
    expect(seo.images.length).toBeGreaterThan(0);
    expect(seo.links.some((href) => href.startsWith('/models/'))).toBe(true);
    expect(seo.text).toContain(fixture.generationData!.meta!.prompt as string);
  });
});
