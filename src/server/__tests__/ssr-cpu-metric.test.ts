/**
 * `ssr_cpu_seconds_total`: units and labels, directly and through the real `_app`/`_document`
 * hooks, and nothing recorded without a server request.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type * as CookiesNext from 'cookies-next';
import type { AppContext } from 'next/app';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  measureSsrCpu,
  SSR_CPU_MEASUREMENTS_METRIC,
  SSR_CPU_METRIC,
} from '~/server/prom/ssr-cpu.metrics';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => ({})),
  deleteCookie: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

// Wholesale on purpose, as in page-render-metric.test.ts: the real module pulls the server env
// schema, the database and redis into the render.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: vi.fn(async () => ({ session: null })),
}));

import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';

const MODEL_ROUTE = '/models/[id]/[[...slug]]';

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

async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

const appGetInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

function runApp(
  req: { headers: Record<string, string>; url: string } | undefined,
  pathname: string
) {
  const noop = () => null;
  // App.getInitialProps calls the page's own getInitialProps, so this is CPU inside the app phase.
  const Component = Object.assign(() => null, { getInitialProps: async () => (burn(), {}) });
  return appGetInitialProps({
    Component,
    AppTree: noop,
    router: {},
    ctx: { req, pathname, query: {}, asPath: req?.url ?? pathname, AppTree: noop },
  } as unknown as AppContext);
}

function runDocument(url: string, pathname: string) {
  return AppDocument.getInitialProps({
    req: { headers: {}, url },
    pathname,
    asPath: url,
    defaultGetInitialProps: async () => {
      burn();
      return { html: '', head: [], styles: [] };
    },
  } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
}

beforeEach(() => {
  usePagesManifestFixture();
  for (const name of [SSR_CPU_METRIC, SSR_CPU_MEASUREMENTS_METRIC]) {
    (instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined)?.reset();
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('measureSsrCpu', () => {
  it('adds the CPU spent in the work, in seconds, under the route pattern', async () => {
    const outer = process.threadCpuUsage();
    const result = await measureSsrCpu(MODEL_ROUTE, 'render', 'html', async () => burn(20));
    const around = process.threadCpuUsage(outer);

    expect(typeof result).toBe('number');
    const [cpu] = await rows(SSR_CPU_METRIC);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'render', kind: 'html' });
    // At least 20ms of CPU was burnt: bounded on both sides so a unit slip either way fails.
    expect(cpu.value).toBeGreaterThanOrEqual(0.02);
    expect(cpu.value).toBeLessThan(1);
    // The recorded span lies inside this one, so a delta taken from the wrong start exceeds it.
    expect(cpu.value).toBeLessThanOrEqual((around.user + around.system) / 1e6);
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toEqual([
      { value: 1, labels: { route: MODEL_ROUTE, phase: 'render', kind: 'html' } },
    ]);
  });

  it('still records when the work throws, and rethrows', async () => {
    await expect(
      measureSsrCpu(MODEL_ROUTE, 'app', 'html', async () => {
        burn();
        throw new Error('getInitialProps failed');
      })
    ).rejects.toThrow('getInitialProps failed');
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toHaveLength(1);
  });

  it.each([
    ['the start reading', 1],
    ['the end reading', 2],
  ])('never fails the work when %s throws, and records nothing', async (_, failingCall) => {
    const real = process.threadCpuUsage.bind(process);
    let calls = 0;
    vi.spyOn(process, 'threadCpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
      if (++calls === failingCall) throw new Error('unsupported');
      return real(prev);
    });
    expect(await measureSsrCpu(MODEL_ROUTE, 'render', 'html', async () => 'ok')).toBe('ok');
    expect(calls).toBe(failingCall);
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toEqual([]);
  });

  it('records nothing in the browser', async () => {
    vi.stubGlobal('window', {});
    expect(await measureSsrCpu(MODEL_ROUTE, 'app', 'html', async () => 'ok')).toBe('ok');
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toEqual([]);
  });
});

describe('_document records the render phase', () => {
  it('labels by the page pattern, not the URL', async () => {
    await runDocument('/models/123/some-model?modelVersionId=9', MODEL_ROUTE);

    const [cpu] = await rows(SSR_CPU_METRIC);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'render', kind: 'html' });
    // renderPage burns 5ms of CPU; a measurement that misses it reads (near) zero.
    expect(cpu.value).toBeGreaterThanOrEqual(0.005);
  });
});

describe('_app records the app phase', () => {
  it('labels an HTML request and a /_next/data request by kind', async () => {
    await runApp({ headers: {}, url: '/models/123/some-model' }, MODEL_ROUTE);
    await runApp({ headers: {}, url: '/_next/data/build-id/models/123.json' }, MODEL_ROUTE);

    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toEqual(
      expect.arrayContaining([
        { value: 1, labels: { route: MODEL_ROUTE, phase: 'app', kind: 'html' } },
        { value: 1, labels: { route: MODEL_ROUTE, phase: 'app', kind: 'data' } },
      ])
    );
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toHaveLength(2);
    // The page's getInitialProps burns 5ms of CPU; a measurement that misses it reads (near) zero.
    for (const cpu of await rows(SSR_CPU_METRIC)) expect(cpu.value).toBeGreaterThanOrEqual(0.005);
    expect(await rows(SSR_CPU_METRIC)).toHaveLength(2);
  });

  it('records nothing on a client-side navigation (no request)', async () => {
    await runApp(undefined, MODEL_ROUTE);
    expect(await rows(SSR_CPU_MEASUREMENTS_METRIC)).toEqual([]);
  });
});
