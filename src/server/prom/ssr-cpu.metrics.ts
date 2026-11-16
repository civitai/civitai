import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { pageRouteLabel } from '~/server/utils/page-routes';
import { SHELL_REQ_KEY } from '~/shared/constants/shell.constants';
import { isNextDataRequest } from '~/server/utils/next-data-request';
import type { SsrPrefetchCohort } from '~/shared/constants/ssr-prefetch-cohort.constants';
import {
  isSsrPrefetchCohort,
  SSR_PREFETCH_COHORT_REQ_KEY,
} from '~/shared/constants/ssr-prefetch-cohort.constants';

// Re-exported for its existing importers; it lives apart so page code can import it without prom-client.
export { isNextDataRequest };

export const SSR_CPU_METRIC = PROM_PREFIX + 'ssr_cpu_seconds_total';
export const SSR_PREFETCH_COHORT_CPU_METRIC =
  PROM_PREFIX + 'ssr_prefetch_cohort_render_cpu_seconds_total';
export const SSR_PREFETCH_COHORT_RENDERS_METRIC = PROM_PREFIX + 'ssr_prefetch_cohort_renders_total';
export const SSR_PREFETCH_COHORT_GSSP_CPU_METRIC =
  PROM_PREFIX + 'ssr_prefetch_cohort_gssp_cpu_seconds_total';
export const SSR_PREFETCH_COHORT_GSSP_METRIC = PROM_PREFIX + 'ssr_prefetch_cohort_gssp_total';

export type SsrRequestKind = 'html' | 'data' | 'shell';

function cpuSecondsCounter(): Counter<'route' | 'phase' | 'kind'> {
  return registerInstrumentationMetric(
    SSR_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_CPU_METRIC,
        help:
          'Main-thread CPU seconds (user + system) spent rendering a page (phase=render: ' +
          '_document.getInitialProps, which runs renderPage), by page route; kind is data for a ' +
          '/_next/data request answered with a rendered page and shell for a static shell render. ' +
          'Excludes V8 worker, libuv pool and ' +
          'Prisma engine threads; under concurrency a measurement also includes CPU of other ' +
          'requests interleaved on the event loop',
        labelNames: ['route', 'phase', 'kind'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

/**
 * The `ssrSignedInSkipPrefetch*` A/Bs (`~/server/utils/ssr-skip-prefetch`): the same render-phase
 * CPU as `ssr_cpu_seconds_total`, for only the requests in the trials' population (signed-in full
 * page loads of an adopting route), split by arm. Each route has its own flag
 * (`SSR_SKIP_PREFETCH_FLAGS`), so `route` also names the trial. Kept off the main metric so its
 * `kind="html"` series mean what they meant before. Per-render CPU = rate(cpu) / rate(renders), per
 * route and cohort.
 */
function cohortCpuCounter(): Counter<'route' | 'cohort'> {
  return registerInstrumentationMetric(
    SSR_PREFETCH_COHORT_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_PREFETCH_COHORT_CPU_METRIC,
        help:
          'Main-thread CPU seconds spent rendering a page (phase=render, as ssr_cpu_seconds_total) ' +
          'for requests in the ssrSignedInSkipPrefetch* trial population, by page route and arm ' +
          "(cohort=skip: loading-shell render; cohort=full: the route's flag is off)",
        labelNames: ['route', 'cohort'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

function cohortRendersCounter(): Counter<'route' | 'cohort'> {
  return registerInstrumentationMetric(
    SSR_PREFETCH_COHORT_RENDERS_METRIC,
    () =>
      new client.Counter({
        name: SSR_PREFETCH_COHORT_RENDERS_METRIC,
        help:
          'Page renders counted into ssr_prefetch_cohort_render_cpu_seconds_total, by page route ' +
          'and ssrSignedInSkipPrefetch* arm',
        labelNames: ['route', 'cohort'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

function cohortGsspCpuCounter(): Counter<'route' | 'cohort'> {
  return registerInstrumentationMetric(
    SSR_PREFETCH_COHORT_GSSP_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_PREFETCH_COHORT_GSSP_CPU_METRIC,
        help:
          'Process CPU seconds (user + system, all threads) spent in createServerSideProps from the ' +
          "page's resolver (its prefetches) through dehydrate, for requests in the " +
          'ssrSignedInSkipPrefetch* trial population, by page route and arm. Diagnostic only: ' +
          'wall-interval, so it includes CPU of requests interleaved on the process',
        labelNames: ['route', 'cohort'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

function cohortGsspCounter(): Counter<'route' | 'cohort'> {
  return registerInstrumentationMetric(
    SSR_PREFETCH_COHORT_GSSP_METRIC,
    () =>
      new client.Counter({
        name: SSR_PREFETCH_COHORT_GSSP_METRIC,
        help:
          'getServerSideProps runs counted into ssr_prefetch_cohort_gssp_cpu_seconds_total, by page ' +
          'route and ssrSignedInSkipPrefetch* arm',
        labelNames: ['route', 'cohort'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

/**
 * One getServerSideProps run of the trial population: `seconds` of process CPU from its resolver
 * through dehydrate (`createServerSideProps` measures it). Never throws.
 */
export function recordSsrPrefetchGsspCpu(
  route: string,
  cohort: SsrPrefetchCohort,
  seconds: number
) {
  try {
    const labels = { route: pageRouteLabel(route), cohort };
    cohortGsspCpuCounter().inc(labels, seconds);
    cohortGsspCounter().inc(labels);
  } catch {
    // Losing one sample is fine.
  }
}

/** The trial arm `getServerSideProps` marked the request with, or `undefined` outside the trial. */
export function ssrPrefetchCohort(req: object): SsrPrefetchCohort | undefined {
  const value = (req as { [SSR_PREFETCH_COHORT_REQ_KEY]?: unknown })[SSR_PREFETCH_COHORT_REQ_KEY];
  return isSsrPrefetchCohort(value) ? value : undefined;
}

type RequestLike = {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [SHELL_REQ_KEY]?: string;
};

/** `shell` for a static shell render (`_app` marks the request), so its CPU reads apart from full renders. */
export function ssrRequestKind(req: RequestLike): SsrRequestKind {
  if (isNextDataRequest(req)) return 'data';
  return req[SHELL_REQ_KEY] ? 'shell' : 'html';
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
  render: () => Promise<T>,
  cohort?: SsrPrefetchCohort
): Promise<T> {
  if (typeof window !== 'undefined') return render();
  const start = cpuNow();
  try {
    return await render();
  } finally {
    if (start) recordRenderCpu(route, kind, start, cohort);
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

function recordRenderCpu(
  route: string,
  kind: SsrRequestKind,
  start: NodeJS.CpuUsage,
  cohort: SsrPrefetchCohort | undefined
) {
  try {
    const { user, system } = process.threadCpuUsage(start);
    const seconds = (user + system) / 1e6;
    const routeLabel = pageRouteLabel(route);
    cpuSecondsCounter().inc({ route: routeLabel, phase: 'render', kind }, seconds);
    if (cohort) {
      cohortCpuCounter().inc({ route: routeLabel, cohort }, seconds);
      cohortRendersCounter().inc({ route: routeLabel, cohort });
    }
  } catch {
    // Losing one sample is fine.
  }
}
