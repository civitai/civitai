import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ReactQuery from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { stringify as devalueStringify } from 'devalue';
import type { GetServerSidePropsContext } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as UnionTransformer from '~/shared/utils/trpc-union-transformer';

/**
 * With `ssr-skip-trpcstate-reparse` on, a full page load hands the server render the dehydrated
 * state `trpcState` was serialised from (patches/@trpc__next@11.17.0.patch), instead of having
 * `withTRPC` parse the string the same request just wrote. Everything here goes through the real
 * `createServerSideProps` and the real `trpc.withTRPC`; only the router, the session layer and the
 * flag are stubbed.
 */

const { flags, writer, probeData } = vi.hoisted(() => {
  // Everything a devalue write can carry that JSON cannot.
  const probeData = (tag: string) => {
    const shared = { tag, role: 'shared' };
    if (tag === 'classy') return { tag, instance: new (class Probe {})() };
    return {
      tag,
      at: new Date(Date.UTC(2024, 2, 4, 5, 6, tag.length)),
      byTag: new Map<string, unknown>([[tag, { n: tag.length }]]),
      tags: new Set([tag, `${tag}-2`]),
      big: BigInt(tag.length) * 10_000_000_000_000_000_000n,
      missing: undefined,
      nested: { list: [1, undefined, { when: new Date(Date.UTC(2020, 0, tag.length)) }] },
      first: shared,
      second: shared,
    };
  };
  return {
    flags: { skipReparse: false },
    writer: { devalue: true },
    probeData,
  };
});

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (flag: string, ...rest: [string?, Record<string, string>?]) =>
      flag === 'ssr-skip-trpcstate-reparse' ? flags.skipReparse : actual.isFliptSync(flag, ...rest),
  };
});
// The SSR pool's dehydrate writer, switchable between devalue (`TRPC_WRITE_DEVALUE=true`) and
// superjson per test.
vi.mock('~/shared/utils/trpc-union-transformer', async (importOriginal) => {
  const actual = await importOriginal<typeof UnionTransformer>();
  return {
    ...actual,
    unionTransformer: actual.buildTransformer((value: unknown) =>
      actual.pickServerWriteSerialize(writer.devalue)(value)
    ),
  };
});
vi.mock('~/server/routers', async () => {
  const { publicProcedure, router } = await import('~/server/trpc');
  return {
    appRouter: router({
      probe: router({
        page: publicProcedure
          .input((value) => value as { tag: string })
          .query(({ input }) => probeData(input.tag)),
      }),
    }),
  };
});

const { createServerSideProps, SSR_DEHYDRATED_STATE } = await import(
  '~/server/utils/server-side-helpers'
);
const { unionDeserialize } = await import('~/shared/utils/trpc-union-transformer');

type Ssg = { probe: { page: { prefetch: (input: { tag: string }) => Promise<void> } } };
type PageProps = Record<PropertyKey, unknown> & { trpcState?: unknown; tag?: string };
type Dehydrated = { queries: { state: { data: unknown } }[] };

const makePage = (prefetch: 'once' | 'always') =>
  createServerSideProps({
    useSSG: true,
    prefetch,
    resolver: async ({ ssg, ctx }) => {
      const tag = String(ctx.query.tag);
      if (ssg) await (ssg as unknown as Ssg).probe.page.prefetch({ tag });
      return { props: { tag } };
    },
  });
const page = makePage('once');

async function load(tag: string, { handler = page, dataRequest = false } = {}) {
  const pathname = dataRequest ? '/_next/data/build-id/probe.json' : '/probe';
  const result = (await handler({
    req: { url: `${pathname}?tag=${tag}`, headers: { host: 'civitai.com' }, cookies: {} },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: { tag },
    resolvedUrl: `/probe?tag=${tag}`,
  } as unknown as GetServerSidePropsContext)) as { props?: PageProps };
  if (!result.props) throw new Error('the page returned no props');
  return result.props;
}

/** See `loadTrpcSideReactQuery` in src/utils/__tests__/trpc-ssr-query-gc.test.ts. */
async function loadTrpcSideReactQuery(): Promise<typeof ReactQuery> {
  const fromTrpc = createRequire(createRequire(import.meta.url).resolve('@trpc/react-query'));
  const pkgDir = path.dirname(fromTrpc.resolve('@tanstack/react-query/package.json'));
  const entry = pathToFileURL(path.join(pkgDir, 'build/modern/index.js')).href;
  return import(/* @vite-ignore */ entry);
}

/** Server-render the page props the way Next does: through `_app`'s `trpc.withTRPC`. */
async function render(gsspProps: PageProps) {
  const { trpc } = await import('~/utils/trpc');
  const { useQueryClient } = await loadTrpcSideReactQuery();
  const seen: { client?: QueryClient } = {};
  function Probe() {
    const client = useQueryClient();
    seen.client = client;
    const rows = client
      .getQueryCache()
      .getAll()
      .map((query) => `${query.queryHash} ${devalueStringify(query.state.data)}`);
    return createElement('pre', null, rows.join('\n'));
  }
  const Wrapped = trpc.withTRPC(Probe) as ComponentType<{ pageProps: object }>;
  // next/dist/server/render.js: `props.pageProps = Object.assign({}, props.pageProps, data.props)`.
  const pageProps = Object.assign({}, {}, gsspProps);
  const html = renderToString(createElement(Wrapped, { pageProps }));
  if (!seen.client) throw new Error('the probe never rendered');
  const queries = seen.client.getQueryCache().getAll();
  return {
    html,
    nextData: JSON.stringify({ props: { pageProps } }),
    queries,
    data: queries[0]?.state.data as ReturnType<typeof probeData>,
  };
}

const rawState = (props: PageProps) => props[SSR_DEHYDRATED_STATE] as Dehydrated | undefined;

beforeEach(() => {
  // dataUpdatedAt / dehydratedAt come from Date.now(): fixed, so two loads can be compared byte for byte.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  flags.skipReparse = false;
  writer.devalue = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ssr-skip-trpcstate-reparse', () => {
  it('leaves the client payload and the server HTML byte-identical', async () => {
    const off = await load('alpha');
    flags.skipReparse = true;
    const on = await load('alpha');

    expect(typeof on.trpcState, 'the SSR pool writes devalue').toBe('string');
    expect(rawState(off)).toBeUndefined();
    expect(rawState(on)).toBeDefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));

    const offRender = await render(off);
    const onRender = await render(on);
    expect(onRender.html).toContain('alpha');
    expect(onRender.html).toBe(offRender.html);
    expect(onRender.nextData).toBe(offRender.nextData);
  });

  it("fills the server render's cache with what parsing trpcState would have", async () => {
    flags.skipReparse = true;
    const props = await load('alpha');
    const onRender = await render(props);
    const parsedRender = await render({ ...props, [SSR_DEHYDRATED_STATE]: undefined });

    // The handover was used: the cache holds the object that was serialised, not a parse of it.
    expect(onRender.data).toBe(rawState(props)?.queries[0].state.data);
    expect(parsedRender.data).not.toBe(onRender.data);

    expect(onRender.queries.map((query) => query.state)).toStrictEqual(
      parsedRender.queries.map((query) => query.state)
    );
    expect(onRender.data).toStrictEqual(
      (unionDeserialize(props.trpcState) as Dehydrated).queries[0].state.data
    );
    const data = onRender.data as Exclude<ReturnType<typeof probeData>, { instance: unknown }>;
    expect(data.at).toBeInstanceOf(Date);
    expect(data.byTag).toBeInstanceOf(Map);
    expect(data.tags).toBeInstanceOf(Set);
    expect(typeof data.big).toBe('bigint');
    expect('missing' in data).toBe(true);
    expect(data.nested.list[2]).toStrictEqual({ when: new Date(Date.UTC(2020, 0, 5)) });
    expect(data.first).toBe(data.second);
  });

  it('does not change the handed-over state while rendering', async () => {
    flags.skipReparse = true;
    const props = await load('alpha');
    const before = devalueStringify(rawState(props));

    await render(props);

    expect(devalueStringify(rawState(props))).toBe(before);
  });

  it("keeps each request's state to that request", async () => {
    flags.skipReparse = true;
    const [alpha, bravo] = await Promise.all([load('alpha'), load('bravo')]);
    const charlie = await load('charlie');

    expect(rawState(alpha)).not.toBe(rawState(bravo));
    expect(rawState(charlie)).not.toBe(rawState(alpha));
    for (const [tag, props] of [
      ['bravo', bravo],
      ['alpha', alpha],
      ['charlie', charlie],
    ] as const) {
      const { data, html } = await render(props);
      expect(data.tag).toBe(tag);
      expect(data).toStrictEqual(probeData(tag));
      expect(html).toContain(tag);
      for (const other of ['alpha', 'bravo', 'charlie'].filter((t) => t !== tag))
        expect(html).not.toContain(other);
    }
  });

  it('keeps parsing a superjson trpcState', async () => {
    flags.skipReparse = true;
    writer.devalue = false;
    const superjsonPool = await load('alpha');
    expect(typeof superjsonPool.trpcState).toBe('object');
    expect(rawState(superjsonPool)).toBeUndefined();

    // A value devalue rejects falls back to superjson on the devalue pool too.
    writer.devalue = true;
    const fallback = await load('classy');
    expect(typeof fallback.trpcState).toBe('object');
    expect(rawState(fallback)).toBeUndefined();
  });

  it('adds nothing to a /_next/data response', async () => {
    const handler = makePage('always');
    const off = await load('alpha', { handler, dataRequest: true });
    flags.skipReparse = true;
    const on = await load('alpha', { handler, dataRequest: true });

    expect(typeof on.trpcState).toBe('string');
    expect(rawState(on)).toBeUndefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});
