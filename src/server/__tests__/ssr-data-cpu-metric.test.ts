/**
 * `ssr_cpu_seconds_total{phase="data"}`: the CPU of a page's getServerSideProps, recorded once per
 * request by the real `createServerSideProps` and labelled by the route pattern `_app` leaves on the
 * request (getServerSideProps itself only sees the URL).
 *
 * Each case replays Next's order on ONE request, as app-static-asset-private.test.ts does: the real
 * `_app.getInitialProps` with the page pattern, then the page's real handler.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type { GetServerSidePropsContext } from 'next';
import type { AppContext } from 'next/app';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
}));

vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

import AppWithTRPC from '~/pages/_app';
import { measureDataCpu, SSR_CPU_METRIC } from '~/server/prom/ssr-cpu.metrics';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PAGE_ROUTE_REQ_KEY } from '~/shared/constants/page-route.constants';

const getInitialProps = (AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => unknown })
  .getInitialProps;

const MODEL_ROUTE = '/models/[id]/[[...slug]]';
const USER_ROUTE = '/user/[username]';

/** Burns at least `ms` of main-thread CPU, timed by CPU rather than wall clock so load can't shorten it. */
function burn(ms = 5) {
  const start = process.threadCpuUsage();
  const deadline = Date.now() + 5000; // a frozen CPU clock must fail the test, not hang it
  let x = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 10_000; i++) x += Math.sqrt(x + 1);
    const { user, system } = process.threadCpuUsage(start);
    if (user + system >= ms * 1000) return x;
  }
  throw new Error('burn: CPU clock did not advance');
}

type Row = { value: number; labels: Record<string, string> };

async function rows(): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

type Exit = 'props' | 'throw' | 'redirect' | 'notFound';

const page = (exit: Exit) =>
  createServerSideProps({
    resolver: async () => {
      burn();
      if (exit === 'throw') throw new Error('page failed');
      if (exit === 'redirect') return { redirect: { destination: '/', permanent: false } };
      if (exit === 'notFound') return { notFound: true };
      return { props: { rendered: true } };
    },
  });

/** `_app` with `route` (skipped when null), then the page's handler, on one request. */
async function serve(route: string | null, url: string, exit: Exit = 'props') {
  const { req, res } = createRealApiPair({ url, headers: { host: 'civitai.com' } });
  if (route) {
    const noop = () => null;
    await getInitialProps({
      Component: noop,
      AppTree: noop,
      router: { locales: ['en'] },
      ctx: { req, res, pathname: route, query: {}, asPath: url, AppTree: noop },
    } as unknown as AppContext);
  }
  // `_app` may record a render of its own in the future; only this handler's phase is under test.
  (instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as client.Counter | undefined)?.reset();
  return page(exit)({
    req,
    res,
    query: {},
    resolvedUrl: url,
  } as unknown as GetServerSidePropsContext);
}

beforeEach(() => {
  usePagesManifestFixture();
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
  (instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as client.Counter | undefined)?.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createServerSideProps records the data phase', () => {
  it('labels it phase=data under the route pattern _app left, not the URL', async () => {
    const result = await serve(MODEL_ROUTE, '/models/123/some-model?modelVersionId=9');

    expect((result as { props?: { rendered?: boolean } }).props?.rendered).toBe(true);
    const [cpu, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'data', kind: 'html' });
    // The resolver burns 5ms of CPU; a measurement that misses it reads (near) zero.
    expect(cpu.value).toBeGreaterThanOrEqual(0.005);
    expect(cpu.value).toBeLessThan(1);
  });

  it('records each route under its own label', async () => {
    const { req: reqA, res: resA } = createRealApiPair({ url: '/models/1', headers: {} });
    const { req: reqB, res: resB } = createRealApiPair({ url: '/user/ivy', headers: {} });
    const noop = () => null;
    const app = (req: unknown, res: unknown, pathname: string, url: string) =>
      getInitialProps({
        Component: noop,
        AppTree: noop,
        router: { locales: ['en'] },
        ctx: { req, res, pathname, query: {}, asPath: url, AppTree: noop },
      } as unknown as AppContext);
    await app(reqA, resA, MODEL_ROUTE, '/models/1');
    await app(reqB, resB, USER_ROUTE, '/user/ivy');
    (
      instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as client.Counter | undefined
    )?.reset();

    const ctx = (req: unknown, res: unknown, url: string) =>
      ({ req, res, query: {}, resolvedUrl: url } as unknown as GetServerSidePropsContext);
    await page('props')(ctx(reqA, resA, '/models/1'));
    await page('props')(ctx(reqB, resB, '/user/ivy'));
    await page('props')(ctx(reqB, resB, '/user/ivy'));

    const byRoute = Object.fromEntries((await rows()).map((r) => [r.labels.route, r]));
    expect(Object.keys(byRoute).sort()).toEqual([MODEL_ROUTE, USER_ROUTE].sort());
    expect(byRoute[MODEL_ROUTE].labels).toEqual({
      route: MODEL_ROUTE,
      phase: 'data',
      kind: 'html',
    });
    expect(byRoute[USER_ROUTE].labels).toEqual({ route: USER_ROUTE, phase: 'data', kind: 'html' });
    // Two requests burnt at least 5ms each on the user route.
    expect(byRoute[USER_ROUTE].value).toBeGreaterThanOrEqual(0.01);
  });

  it('labels a /_next/data request kind="data"', async () => {
    await serve(MODEL_ROUTE, '/_next/data/build-id/models/123.json');
    expect((await rows()).map((r) => r.labels)).toEqual([
      { route: MODEL_ROUTE, phase: 'data', kind: 'data' },
    ]);
  });

  it('still records when the resolver throws, and rethrows unchanged', async () => {
    await expect(serve(MODEL_ROUTE, '/models/1', 'throw')).rejects.toThrow('page failed');
    const [cpu, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'data', kind: 'html' });
    expect(cpu.value).toBeGreaterThanOrEqual(0.005);
  });

  it.each([
    ['redirect', { redirect: { destination: '/', permanent: false } }],
    ['notFound', { notFound: true }],
  ] as const)('still records on a %s, which is returned unchanged', async (exit, expected) => {
    expect(await serve(MODEL_ROUTE, '/models/1', exit)).toEqual(expected);
    const [cpu, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'data', kind: 'html' });
    expect(cpu.value).toBeGreaterThanOrEqual(0.005);
  });

  it('labels route="none" when no _app ran before it', async () => {
    await serve(null, '/models/1');
    expect((await rows()).map((r) => r.labels)).toEqual([
      { route: 'none', phase: 'data', kind: 'html' },
    ]);
  });
});

describe('measureDataCpu', () => {
  const req = { url: '/models/1', headers: {}, [PAGE_ROUTE_REQ_KEY]: MODEL_ROUTE };

  it.each([
    ['the start reading', 1],
    ['the end reading', 2],
  ])('never fails the request when %s throws, and records nothing', async (_, failingCall) => {
    const real = process.threadCpuUsage.bind(process);
    let calls = 0;
    vi.spyOn(process, 'threadCpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
      if (++calls === failingCall) throw new Error('unsupported');
      return real(prev);
    });
    expect(await measureDataCpu(req, async () => 'ok')).toBe('ok');
    expect(calls).toBe(failingCall);
    expect(await rows()).toEqual([]);
  });

  it('records nothing in the browser', async () => {
    vi.stubGlobal('window', {});
    expect(await measureDataCpu(req, async () => burn())).toEqual(expect.any(Number));
    expect(await rows()).toEqual([]);
  });
});
