/**
 * `ssr_cpu_seconds_total`: units and labels, directly and through the real `_document` hook, and
 * nothing recorded in the browser.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppDocument from '~/pages/_document';
import {
  measureRenderCpu,
  recordSsrPrefetchGsspCpu,
  SSR_CPU_METRIC,
  SSR_PREFETCH_COHORT_GSSP_CPU_METRIC,
  SSR_PREFETCH_COHORT_GSSP_METRIC,
  SSR_PREFETCH_COHORT_CPU_METRIC,
  SSR_PREFETCH_COHORT_RENDERS_METRIC,
} from '~/server/prom/ssr-cpu.metrics';
import { SSR_PREFETCH_COHORT_REQ_KEY } from '~/shared/constants/ssr-prefetch-cohort.constants';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

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

async function rows(name = SSR_CPU_METRIC): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

const COHORT_METRICS = [
  SSR_PREFETCH_COHORT_CPU_METRIC,
  SSR_PREFETCH_COHORT_RENDERS_METRIC,
  SSR_PREFETCH_COHORT_GSSP_CPU_METRIC,
  SSR_PREFETCH_COHORT_GSSP_METRIC,
];

function runDocument(
  req: { url: string; headers: Record<string, string>; [SSR_PREFETCH_COHORT_REQ_KEY]?: string },
  pathname: string
) {
  return AppDocument.getInitialProps({
    req,
    pathname,
    asPath: req.url,
    defaultGetInitialProps: async () => {
      burn();
      return { html: '', head: [], styles: [] };
    },
  } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
}

beforeEach(() => {
  usePagesManifestFixture();
  for (const name of [SSR_CPU_METRIC, ...COHORT_METRICS]) {
    (instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined)?.reset();
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('measureRenderCpu', () => {
  it('adds the CPU spent in the render, in seconds, under the route pattern', async () => {
    const outer = process.threadCpuUsage();
    const result = await measureRenderCpu(MODEL_ROUTE, 'html', async () => burn(20));
    const around = process.threadCpuUsage(outer);

    expect(typeof result).toBe('number');
    const [cpu, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'render', kind: 'html' });
    // At least 20ms of CPU was burnt: bounded on both sides so a unit slip either way fails.
    expect(cpu.value).toBeGreaterThanOrEqual(0.02);
    expect(cpu.value).toBeLessThan(1);
    // The recorded span lies inside this one, so a delta taken from the wrong start exceeds it.
    expect(cpu.value).toBeLessThanOrEqual((around.user + around.system) / 1e6);
  });

  it('still records when the render throws, and rethrows', async () => {
    await expect(
      measureRenderCpu(MODEL_ROUTE, 'html', async () => {
        burn();
        throw new Error('render failed');
      })
    ).rejects.toThrow('render failed');
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    ['the start reading', 1],
    ['the end reading', 2],
  ])('never fails the render when %s throws, and records nothing', async (_, failingCall) => {
    const real = process.threadCpuUsage.bind(process);
    let calls = 0;
    vi.spyOn(process, 'threadCpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
      if (++calls === failingCall) throw new Error('unsupported');
      return real(prev);
    });
    expect(await measureRenderCpu(MODEL_ROUTE, 'html', async () => 'ok')).toBe('ok');
    expect(calls).toBe(failingCall);
    expect(await rows()).toEqual([]);
  });

  it('records nothing in the browser', async () => {
    vi.stubGlobal('window', {});
    expect(await measureRenderCpu(MODEL_ROUTE, 'html', async () => 'ok')).toBe('ok');
    expect(await rows()).toEqual([]);
  });
});

describe('_document records the render', () => {
  it('labels by the page pattern, not the URL', async () => {
    await runDocument({ url: '/models/123/some-model?modelVersionId=9', headers: {} }, MODEL_ROUTE);

    const [cpu] = await rows();
    expect(cpu.labels).toEqual({ route: MODEL_ROUTE, phase: 'render', kind: 'html' });
    // renderPage burns 5ms of CPU; a measurement that misses it reads (near) zero.
    expect(cpu.value).toBeGreaterThanOrEqual(0.005);
  });

  // The request shapes a `/_next/data` render arrives with, as recorded from a built Next 16.3.1
  // app: with a proxy both markers are set; without one the header is absent.
  it.each([
    ['data URL and header', '/_next/data/build-id/models/123.json', { 'x-nextjs-data': '1' }],
    ['data URL only', '/_next/data/build-id/models/123.json', {}],
    ['header only', '/models/123', { 'x-nextjs-data': '1' }],
  ])('labels a /_next/data render kind="data" (%s)', async (_, url, headers) => {
    await runDocument({ url, headers }, MODEL_ROUTE);
    expect((await rows()).map((r) => r.labels)).toEqual([
      { route: MODEL_ROUTE, phase: 'render', kind: 'data' },
    ]);
  });
});

describe('_document records the ssrSignedInSkipPrefetch arm', () => {
  it.each(['skip', 'full'])(
    'a request getServerSideProps marked cohort=%s: its render CPU and one render, by route and arm',
    async (cohort) => {
      await runDocument(
        { url: '/models/123/some-model', headers: {}, [SSR_PREFETCH_COHORT_REQ_KEY]: cohort },
        MODEL_ROUTE
      );

      const [cpu, ...rest] = await rows(SSR_PREFETCH_COHORT_CPU_METRIC);
      expect(rest).toEqual([]);
      expect(cpu.labels).toEqual({ route: MODEL_ROUTE, cohort });
      // renderPage burns 5ms of CPU.
      expect(cpu.value).toBeGreaterThanOrEqual(0.005);
      expect(cpu.value).toBeLessThan(1);
      expect(await rows(SSR_PREFETCH_COHORT_RENDERS_METRIC)).toEqual([
        { value: 1, labels: { route: MODEL_ROUTE, cohort } },
      ]);
      // The main metric is unchanged by the mark: same series, same kind.
      expect((await rows()).map((r) => r.labels)).toEqual([
        { route: MODEL_ROUTE, phase: 'render', kind: 'html' },
      ]);
    }
  );

  it.each([
    ['no mark', undefined],
    ['an unknown mark', 'bogus'],
  ])('%s: nothing in the cohort metrics, the main metric as before', async (_, mark) => {
    await runDocument(
      {
        url: '/models/123/some-model',
        headers: {},
        ...(mark ? { [SSR_PREFETCH_COHORT_REQ_KEY]: mark } : {}),
      },
      MODEL_ROUTE
    );

    // Control: the render itself was measured, so the empty cohort rows are the mark speaking.
    expect(await rows()).toHaveLength(1);
    for (const name of COHORT_METRICS) expect(await rows(name)).toEqual([]);
  });
});

describe('recordSsrPrefetchGsspCpu', () => {
  it('adds the seconds and one run under the route pattern and arm', async () => {
    recordSsrPrefetchGsspCpu(MODEL_ROUTE, 'full', 0.125);
    recordSsrPrefetchGsspCpu(MODEL_ROUTE, 'full', 0.5);
    recordSsrPrefetchGsspCpu(MODEL_ROUTE, 'skip', 0.03);

    const byCohort = (rs: Row[]) =>
      Object.fromEntries(rs.map((r) => [`${r.labels.route} ${r.labels.cohort}`, r.value]));
    expect(byCohort(await rows(SSR_PREFETCH_COHORT_GSSP_CPU_METRIC))).toEqual({
      [`${MODEL_ROUTE} full`]: 0.625,
      [`${MODEL_ROUTE} skip`]: 0.03,
    });
    expect(byCohort(await rows(SSR_PREFETCH_COHORT_GSSP_METRIC))).toEqual({
      [`${MODEL_ROUTE} full`]: 2,
      [`${MODEL_ROUTE} skip`]: 1,
    });
    // The render metrics are untouched.
    expect(await rows()).toEqual([]);
    expect(await rows(SSR_PREFETCH_COHORT_CPU_METRIC)).toEqual([]);
  });
});
