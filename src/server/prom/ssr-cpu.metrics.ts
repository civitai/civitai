import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { pageRouteLabel } from '~/server/utils/page-routes';

export const SSR_CPU_METRIC = PROM_PREFIX + 'ssr_cpu_seconds_total';

export type SsrRequestKind = 'html' | 'data';

function cpuSecondsCounter(): Counter<'route' | 'phase' | 'kind'> {
  return registerInstrumentationMetric(
    SSR_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_CPU_METRIC,
        help:
          'Main-thread CPU seconds (user + system) spent rendering a page (phase=render: ' +
          '_document.getInitialProps, which runs renderPage), by page route; kind is data for a ' +
          '/_next/data request answered with a rendered page. Excludes V8 worker, libuv pool and ' +
          'Prisma engine threads; under concurrency a measurement also includes CPU of other ' +
          'requests interleaved on the event loop',
        labelNames: ['route', 'phase', 'kind'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

type RequestLike = { url?: string; headers: Record<string, string | string[] | undefined> };

/**
 * A page without getServerSideProps still renders a full document for a `/_next/data` request.
 * Next sets `x-nextjs-data` on such requests when the app has a proxy and leaves `req.url` as the
 * data URL; either marks the request.
 */
export function ssrRequestKind(req: RequestLike): SsrRequestKind {
  return req.headers['x-nextjs-data'] === '1' || req.url?.startsWith('/_next/data')
    ? 'data'
    : 'html';
}

/**
 * Adds the main thread's CPU across `render` under `route`, which must be the page pattern
 * (`ctx.pathname`), never the URL: a URL is not a manifest pattern, so it labels as `other`.
 *
 * Limits of a `process.threadCpuUsage()` delta:
 * - Main thread only: V8 GC/compiler, libuv pool and Prisma engine threads are excluded (they are
 *   the other `thread_group`s of `civitai_app_thread_cpu_seconds_total`).
 * - Wall-interval, not per-request: CPU of requests interleaved while `render` awaits lands here,
 *   so every route over-reads under concurrency. Sanity check: the sum over all routes can exceed
 *   `civitai_app_thread_cpu_seconds_total{thread_group="main"}` only through overlap, and since that
 *   total also holds API/tRPC work, a sum near it means overlap dominates.
 */
export async function measureRenderCpu<T>(
  route: string,
  kind: SsrRequestKind,
  render: () => Promise<T>
): Promise<T> {
  if (typeof window !== 'undefined') return render();
  const start = cpuNow();
  try {
    return await render();
  } finally {
    if (start) recordRenderCpu(route, kind, start);
  }
}

// Metrics must never fail the request they observe.
function cpuNow(): NodeJS.CpuUsage | undefined {
  try {
    return process.threadCpuUsage();
  } catch {
    return undefined;
  }
}

function recordRenderCpu(route: string, kind: SsrRequestKind, start: NodeJS.CpuUsage) {
  try {
    const { user, system } = process.threadCpuUsage(start);
    cpuSecondsCounter().inc(
      { route: pageRouteLabel(route), phase: 'render', kind },
      (user + system) / 1e6
    );
  } catch {
    // Losing one sample is fine.
  }
}
