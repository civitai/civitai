/**
 * Content parity for the bot lean render of `/models/[id]/[[...slug]]`
 * (`~/server/bot-cache/bot-lean`, `~/server/bot-cache/lean/models-lean`): the SAME request is
 * rendered twice through Next's own pages renderer (`renderToHTML`) over the REAL `_app`,
 * `_document`, page module, resolver and model page tree — once with `bot-lean-render` off (the
 * full React render) and once on (the lean page) — and what a crawler reads from each is compared
 * (`~/server/bot-cache/bot-lean-seo`): title, the SEO `<meta>`s, canonical, alternate, JSON-LD
 * (parsed, deep-equal), headings, the visible text runs in order, every body `<img>`, every link
 * (with its nofollow), the outcome (status, or the redirect and its target) and `X-Robots-Tag`.
 * The page is indexed, so a difference here is cloaking.
 *
 * What is real and what is not:
 * - `getDefaultModelVersion` and the browsing-settings addons are stand-ins, and the resolver's
 *   seven prefetch procedures are swapped in the REAL router's procedure table for this file; the
 *   resolver itself, the SSG helpers, their query cache and `dehydrate` are the real ones.
 * - The React tree's `trpc` hooks run on a REAL React Query client hydrated from the render's own
 *   `trpcState`, so a query the page did not prefetch is pending, exactly as in production.
 * - Feature flags are the real `getFeatureFlagsAsync` for the green host, with every Flipt-backed
 *   flag unset except the ones this path reads.
 *
 * Every fixture also checks which path the flag-on request took — the lean page (counter `render`,
 * no `__NEXT_DATA__`), a named fallback, or none at all (a redirect, a 404, or a request that is
 * not a bot-cache render) — so a pass can never be two full renders compared with each other.
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
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as SystemCache from '~/server/services/system-cache';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { ModelFixture } from './bot-lean-models.fixtures';

const h = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return {
    serve: false,
    shadow: false,
    fixture: undefined as unknown as ModelFixture,
    bootstrap: vi.fn(),
  };
});

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => ({})),
  isFliptSync: vi.fn((key: string) => {
    if (key === 'bot-html-edge-cache') return true;
    if (key === 'bot-lean-render') return h.serve;
    if (key === 'bot-lean-render-shadow') return h.shadow;
    if (h.fixture?.flipt?.includes(key)) return true;
    return null;
  }),
}));

// The origin cache keys on a real build id, and a test has no `.next/BUILD_ID`.
vi.mock('~/server/shell/shell-response', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellResponse>()),
  shellBuildId: () => 'bot-lean-models-parity-test-build',
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

// The resolver's one direct service read (a database query in production).
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getDefaultModelVersion: vi.fn(async () => h.fixture.defaultVersion ?? undefined),
}));

// The carousel prefetch's addons (redis in production). The bootstrap hands the client the same
// list, so the prefetch and the client query are keyed alike, as they are in production.
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(async () => []),
}));

// The React tree's tRPC client: every `useQuery`/`useInfiniteQuery` is React Query's own, on a
// client hydrated from the page's `trpcState` (what the patched `withTRPC` does), keyed exactly as
// tRPC keys it, with a query function that never settles — a server render never fetches.
// Mutations, `useUtils` and `useQueries` are the inert proxy's (`test/trpcProxyStub`).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const original = await importOriginal<typeof TrpcModule>();
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { useState } = await import('react');
  const RQ = await import('@tanstack/react-query');
  const { unionDeserialize } = await import('~/shared/utils/trpc-union-transformer');

  const withTRPC = (AppComponent: ComponentType<object> & { getInitialProps?: unknown }) => {
    const WithQueryClient = (props: { pageProps?: { trpcState?: unknown } }) => {
      const [client] = useState(() => {
        // The app's own defaults (`staleTime: Infinity` above all): with React Query's, a hydrated
        // query is stale on the server, reports a refetch, and `useQueryImages` drops its items.
        const queryClient = new RQ.QueryClient(original.queryClientConfig);
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
  return { ...original, trpc };
});

import { initTRPC, TRPCError } from '@trpc/server';
import type { ServerResponse } from 'http';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import * as ModelPage from '~/pages/models/[id]/[[...slug]]';
import { appRouter } from '~/server/routers';
import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';
import {
  BOT_LEAN_RENDER_METRIC,
  BOT_LEAN_SHADOW_METRIC,
  resetBotLeanFlagGateForTests,
  shadowBotLeanRender,
} from '~/server/bot-cache/bot-lean';
import { extractSeo, seoOf } from '~/server/bot-cache/bot-lean-seo';
import type { RoutePage } from './bot-cache-render.harness';
import { makeReq, NOW, renderPage, SECRET } from './bot-cache-render.harness';
import { FIXTURES } from './bot-lean-models.fixtures';

/**
 * The resolver's prefetches, answered from the fixture: their entries in the REAL router's
 * procedure table are swapped for stand-ins for this file and put back after it (not a `vi.mock`
 * of `~/server/routers`, which under `isolate: false` would outlive the file).
 */
const t = initTRPC.create();
const answer = (value: unknown) => {
  if (value === undefined) throw new TRPCError({ code: 'NOT_FOUND' });
  return value;
};
const anyInput = (v: unknown) => v;
const NO_HIDDEN = {
  hiddenTags: [],
  hiddenUsers: [],
  hiddenModels: [],
  hiddenModel3Ds: [],
  hiddenImages: [],
  blockedUsers: [],
  blockedByUsers: [],
};
const standIns = t.router({
  model: t.router({
    getById: t.procedure.input(anyInput).query(() => answer(h.fixture.model)),
    getCollectionShowcase: t.procedure.input(anyInput).query(() => h.fixture.showcase),
  }),
  hiddenPreferences: t.router({ getHidden: t.procedure.query(() => NO_HIDDEN) }),
  common: t.router({
    getEntityAccess: t.procedure.input(anyInput).query(({ input }) =>
      ((input as { entityId: number[] }).entityId ?? []).map((entityId) => ({
        entityId,
        entityType: 'ModelVersion',
        hasAccess: true,
        permissions: 0,
        availability: 'Public',
      }))
    ),
  }),
  user: t.router({
    getCreator: t.procedure.input(anyInput).query(() => answer(h.fixture.creator ?? undefined)),
  }),
  blocks: t.router({ listForModel: t.procedure.input(anyInput).query(() => []) }),
  image: t.router({
    getInfinite: t.procedure
      .input(anyInput)
      .query(() => ({ items: h.fixture.images, nextCursor: undefined })),
  }),
});
const STAND_IN_PATHS = [
  'model.getById',
  'model.getCollectionShowcase',
  'hiddenPreferences.getHidden',
  'common.getEntityAccess',
  'user.getCreator',
  'blocks.listForModel',
  'image.getInfinite',
] as const;
type Procedures = { _def: { procedures: Record<string, unknown> } };
const tableOf = (router: unknown) => (router as Procedures)._def.procedures;
const realProcedures = new Map<string, unknown>();

const MODEL_PAGE: RoutePage = {
  route: '/models/[id]/[[...slug]]',
  Component: ModelPage.default as never,
  getServerSideProps: ModelPage.getServerSideProps,
  params: (path) => {
    const [, , id, ...slug] = path.split('/');
    // Next hands a catch-all segment over as an array.
    const params = { id: id!, ...(slug.length ? { slug } : {}) };
    return params as unknown as Record<string, string>;
  },
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

async function counterTotal(metricName: string, labels: Record<string, string> = {}) {
  const metric = instrumentationRegistry.getSingleMetric(metricName);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

function setFlags({ serve = false, shadow = false }: { serve?: boolean; shadow?: boolean }) {
  h.serve = serve;
  h.shadow = shadow;
  resetBotLeanFlagGateForTests();
}

type Outcome =
  | { kind: 'page'; status: number }
  | { kind: 'not-found' }
  | { kind: 'redirect'; status: number; location: string };

/** What Next would answer: the page (and its status), a 404, or a redirect and its target. */
function outcomeOf(html: string, status: number): Outcome {
  if (html === '') return { kind: 'not-found' };
  if (html.startsWith('{')) {
    const { pageProps } = JSON.parse(html) as {
      pageProps: { __N_REDIRECT: string; __N_REDIRECT_STATUS: number };
    };
    return { kind: 'redirect', status: pageProps.__N_REDIRECT_STATUS, location: pageProps.__N_REDIRECT };
  }
  return { kind: 'page', status };
}

async function renderModel(fixture: ModelFixture, flags: { serve?: boolean; shadow?: boolean }) {
  h.fixture = fixture;
  setFlags(flags);
  const req = makeReq(fixture.url, { headers: fixture.headers ?? {} });
  const res = makeSendingRes();
  const returned = await renderPage(MODEL_PAGE, req as never, res as never);
  const html = res.body ?? returned;
  return { html, res, outcome: outcomeOf(html, res.statusCode), headers: res.getHeaders() };
}

beforeAll(() => {
  const table = tableOf(appRouter);
  const fakes = tableOf(standIns);
  for (const path of STAND_IN_PATHS) {
    realProcedures.set(path, table[path]);
    table[path] = fakes[path];
  }
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  // The hub's OAuth provider list fails open.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});
afterAll(() => {
  const table = tableOf(appRouter);
  for (const [path, procedure] of realProcedures) {
    if (procedure === undefined) delete table[path];
    else table[path] = procedure;
  }
  vi.mocked(Date.now).mockRestore();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  resetBotCacheFlagGateForTests();
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({
    session: null,
    liveNow: false,
    browsingSettingsAddons: [],
  }));
});

describe('bot lean render of /models/[id]: what a crawler reads is the full render', () => {
  it.each(FIXTURES.map((f) => [f.label, f] as const))('%s', async (_, fixture) => {
    const full = await renderModel(fixture, {});
    const before = await counterTotal(BOT_LEAN_RENDER_METRIC, { route: 'models' });
    const expected =
      fixture.expect === 'lean'
        ? { event: 'render', reason: '' }
        : { event: 'fallback', reason: fixture.expect };
    const beforePath = await counterTotal(BOT_LEAN_RENDER_METRIC, { route: 'models', ...expected });
    const lean = await renderModel(fixture, { serve: true });
    const after = await counterTotal(BOT_LEAN_RENDER_METRIC, { route: 'models' });
    const afterPath = await counterTotal(BOT_LEAN_RENDER_METRIC, { route: 'models', ...expected });

    // Positive control: the flag-on request took the path the fixture says it does.
    await vi.dynamicImportSettled();
    const failures = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry?.name === 'bot-lean-render');
    expect.soft(failures, 'the lean path logged no failure').toEqual([]);
    if (fixture.expect === 'none') {
      expect.soft(after - before, 'the lean hook never ran').toBe(0);
    } else {
      expect.soft(afterPath - beforePath, `counter for ${fixture.expect}`).toBe(1);
    }
    expect.soft(lean.outcome, 'outcome').toEqual(full.outcome);
    expect.soft(lean.headers['x-robots-tag'], 'X-Robots-Tag').toEqual(full.headers['x-robots-tag']);
    if (full.outcome.kind !== 'page') return;

    expect(extractSeo(full.html).hasNextData, 'the flag-off render is the full one').toBe(true);
    expect(extractSeo(lean.html).hasNextData, 'the flag-on render is lean').toBe(
      fixture.expect !== 'lean'
    );
    // One assertion per field, so a run names every field that differs.
    const fullSeo = seoOf(full.html);
    const leanSeo = seoOf(lean.html);
    const differs = (Object.keys(fullSeo) as (keyof typeof fullSeo)[]).filter(
      (field) => JSON.stringify(fullSeo[field]) !== JSON.stringify(leanSeo[field])
    );
    // The whole of both sides when anything differs: a CI log is the only place to read them.
    if (differs.length)
      console.log(`PARITY ${fixture.label}\n${JSON.stringify({ fullSeo, leanSeo }, null, 1)}`);
    for (const field of Object.keys(fullSeo) as (keyof typeof fullSeo)[])
      expect.soft(leanSeo[field], field).toEqual(fullSeo[field]);
  });
});

describe('the lean page', () => {
  it('is private to browsers and sets no cookie', async () => {
    const lean = await renderModel(FIXTURES[0]!, { serve: true });
    expect(extractSeo(lean.html).hasNextData).toBe(false);
    expect(lean.headers['cache-control']).toBe('private, no-store');
    expect(lean.headers).not.toHaveProperty('set-cookie');
    expect(lean.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('a query key the renderer does not read falls back', async () => {
    const before = await counterTotal(BOT_LEAN_RENDER_METRIC, { event: 'fallback', reason: 'query' });
    const fixture = { ...FIXTURES[0]!, url: `${FIXTURES[0]!.url}?view=basic` };
    const lean = await renderModel(fixture, { serve: true });
    expect(extractSeo(lean.html).hasNextData).toBe(true);
    const after = await counterTotal(BOT_LEAN_RENDER_METRIC, { event: 'fallback', reason: 'query' });
    expect(after - before).toBe(1);
  });

  it('INSTRUMENT CHECK: the extract tells two different versions apart', async () => {
    const one = await renderModel(FIXTURES[0]!, {});
    const two = await renderModel(FIXTURES[1]!, {});
    expect(seoOf(two.html).title).not.toEqual(seoOf(one.html).title);
  });

  it('INSTRUMENT CHECK: the full render carries the content the extract compares', async () => {
    const seo = seoOf((await renderModel(FIXTURES[0]!, {})).html);
    expect(seo.title.length).toBe(1);
    expect(seo.canonical.length).toBe(1);
    expect(seo.jsonLd.length).toBeGreaterThan(1);
    expect(seo.headings.length).toBeGreaterThan(0);
    expect(seo.images.length).toBeGreaterThan(0);
    expect(seo.links.some((href) => href.startsWith('/user/'))).toBe(true);
    expect(seo.meta.some(([name]) => name === 'description')).toBe(true);
  });
});

describe('shadow mode', () => {
  /** A render, then what Next's `sendRenderResult` does with it (`send-payload.js`). */
  async function renderAndSend(fixture: ModelFixture) {
    const { html, res } = await renderModel(fixture, { shadow: true });
    (res.end as (chunk: string) => void).call(res, html);
    return html;
  }

  it('serves the full page and counts a match for a page the lean render reproduces', async () => {
    const before = await counterTotal(BOT_LEAN_SHADOW_METRIC, { route: 'models', result: 'match' });
    const html = await renderAndSend(FIXTURES[0]!);
    expect(extractSeo(html).hasNextData, 'shadow serves the full page').toBe(true);
    await vi.waitFor(async () =>
      expect(
        await counterTotal(BOT_LEAN_SHADOW_METRIC, { route: 'models', result: 'match' })
      ).toBe(before + 1)
    );
  });

  it('INSTRUMENT CHECK: counts and names the fields of a lean page that differs', async () => {
    const res = makeSendingRes();
    const req = makeReq('/models/1/x');
    const lean = '<html><head><title>Not the page</title></head><body><a href="/x">x</a></body>';
    const full = '<html><head><title>The page</title></head><body><a href="/y">y</a></body>';
    const before = await counterTotal(BOT_LEAN_SHADOW_METRIC, { result: 'diff', field: 'links' });
    await shadowBotLeanRender('models', req as never, res as unknown as ServerResponse, [], async () => ({
      html: lean,
    }));
    (res.end as (chunk: string) => void).call(res, full);
    await vi.waitFor(async () =>
      expect(await counterTotal(BOT_LEAN_SHADOW_METRIC, { result: 'diff', field: 'links' })).toBe(
        before + 1
      )
    );
    expect(await counterTotal(BOT_LEAN_SHADOW_METRIC, { result: 'diff', field: 'title' })).toBeGreaterThan(0);
  });
});
