import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { pageRouteLabel } from '~/server/utils/page-routes';

export const SSR_CPU_METRIC = PROM_PREFIX + 'ssr_cpu_seconds_total';
export const SSR_CPU_MEASUREMENTS_METRIC = PROM_PREFIX + 'ssr_cpu_measurements_total';

/** `app`: `_app.getInitialProps`. `render`: `_document.getInitialProps`, i.e. `renderPage()`. */
export type SsrCpuPhase = 'app' | 'render';
export type SsrRequestKind = 'html' | 'data';

type Labels = 'route' | 'phase' | 'kind';

function cpuSecondsCounter(): Counter<Labels> {
  return registerInstrumentationMetric(
    SSR_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_CPU_METRIC,
        help:
          'Main-thread CPU seconds (user + system) spent in an SSR phase, by page route; kind is ' +
          'data for a /_next/data request (render is always html). Excludes V8 worker, libuv pool ' +
          'and Prisma engine threads; under concurrency a measurement also includes CPU of other ' +
          'requests interleaved on the event loop',
        labelNames: ['route', 'phase', 'kind'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

function measurementsCounter(): Counter<Labels> {
  return registerInstrumentationMetric(
    SSR_CPU_MEASUREMENTS_METRIC,
    () =>
      new client.Counter({
        name: SSR_CPU_MEASUREMENTS_METRIC,
        help: `Measurements added to ${SSR_CPU_METRIC}; divide by it for CPU per request`,
        labelNames: ['route', 'phase', 'kind'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

/** Same test as `createServerSideProps` in `server-side-helpers.ts`; keep the two in step. */
export function ssrRequestKind(url: string | undefined): SsrRequestKind {
  return url?.startsWith('/_next/data') ? 'data' : 'html';
}

/**
 * Adds the main thread's CPU across `work` under `route`, which must be the page pattern
 * (`ctx.pathname`), never the URL: a URL is not a manifest pattern, so it labels as `other`.
 *
 * Limits of a `process.threadCpuUsage()` delta:
 * - Main thread only: V8 GC/compiler, libuv pool and Prisma engine threads are excluded (they are
 *   the other `thread_group`s of `civitai_app_thread_cpu_seconds_total`).
 * - Wall-interval, not per-request: CPU of requests interleaved while `work` awaits lands here, so
 *   every route over-reads under concurrency, `app` (awaits I/O) more than `render`; rank routes
 *   by `render`. Sanity check: the sum over all routes and phases can exceed
 *   `civitai_app_thread_cpu_seconds_total{thread_group="main"}` only through overlap, and since that
 *   total also holds API/tRPC work, a sum near it means overlap dominates.
 */
export async function measureSsrCpu<T>(
  route: string,
  phase: SsrCpuPhase,
  kind: SsrRequestKind,
  work: () => Promise<T>
): Promise<T> {
  if (typeof window !== 'undefined') return work();
  const start = cpuNow();
  try {
    return await work();
  } finally {
    if (start) recordSsrCpu(route, phase, kind, start);
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

function recordSsrCpu(
  route: string,
  phase: SsrCpuPhase,
  kind: SsrRequestKind,
  start: NodeJS.CpuUsage
) {
  try {
    const { user, system } = process.threadCpuUsage(start);
    const labels = { route: pageRouteLabel(route), phase, kind };
    cpuSecondsCounter().inc(labels, (user + system) / 1e6);
    measurementsCounter().inc(labels);
  } catch {
    // Losing one sample is fine.
  }
}
