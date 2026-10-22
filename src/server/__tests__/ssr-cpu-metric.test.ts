/**
 * `ssr_cpu_seconds_total`: units and labels, directly and through the real `_document` hook, and
 * nothing recorded in the browser.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppDocument from '~/pages/_document';
import { measureRenderCpu, SSR_CPU_METRIC } from '~/server/prom/ssr-cpu.metrics';
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

async function rows(): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

function runDocument(req: { url: string; headers: Record<string, string> }, pathname: string) {
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
  (instrumentationRegistry.getSingleMetric(SSR_CPU_METRIC) as client.Counter | undefined)?.reset();
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
