import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { pageRouteLabel } from '~/server/utils/page-routes';
import { PAGE_ROUTE_REQ_KEY } from '~/shared/constants/page-route.constants';
import { SHELL_REQ_KEY } from '~/shared/constants/shell.constants';

export const SSR_CPU_METRIC = PROM_PREFIX + 'ssr_cpu_seconds_total';

export type SsrRequestKind = 'html' | 'data' | 'shell';
export type SsrCpuPhase = 'data' | 'render';

function cpuSecondsCounter(): Counter<'route' | 'phase' | 'kind'> {
  return registerInstrumentationMetric(
    SSR_CPU_METRIC,
    () =>
      new client.Counter({
        name: SSR_CPU_METRIC,
        help:
          'Main-thread CPU seconds (user + system) spent serving a page, by page route and phase: ' +
          'phase=data is getServerSideProps (session, flags, the resolver and its prefetches, ' +
          'dehydrating the state), phase=render is _document.getInitialProps (renderPage); the two ' +
          'never overlap. kind is data for a /_next/data request and shell for a static shell ' +
          'render. ' +
          'Excludes V8 worker, libuv pool and ' +
          'Prisma engine threads; under concurrency a measurement also includes CPU of other ' +
          'requests interleaved on the event loop',
        labelNames: ['route', 'phase', 'kind'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

type RequestLike = {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [SHELL_REQ_KEY]?: string;
};

type PageRequestLike = RequestLike & { [PAGE_ROUTE_REQ_KEY]?: string };

/**
 * A page without getServerSideProps still renders a full document for a `/_next/data` request.
 * Next sets `x-nextjs-data` on such requests when the app has a proxy and leaves `req.url` as the
 * data URL; either marks the request.
 */
export function isNextDataRequest(req: Omit<RequestLike, typeof SHELL_REQ_KEY>): boolean {
  return req.headers['x-nextjs-data'] === '1' || !!req.url?.startsWith('/_next/data');
}

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
  render: () => Promise<T>
): Promise<T> {
  if (typeof window !== 'undefined') return render();
  const start = cpuNow();
  try {
    return await render();
  } finally {
    if (start) recordCpu(route, 'render', kind, start);
  }
}

/**
 * Adds the main thread's CPU across a page's getServerSideProps (`run`) under phase="data", the
 * work before the render that `measureRenderCpu` covers: Next calls getServerSideProps and only then
 * renders, so the two phases never overlap. Recorded on a throw, a redirect and a notFound too.
 *
 * The route is the pattern `_app` left on the request (`PAGE_ROUTE_REQ_KEY`); without one it
 * labels `none`. The kind is read after `run`, from the marks `_app` set before it. Same limits as
 * `measureRenderCpu`: main thread only, and interleaved requests' CPU lands in the interval.
 */
export async function measureDataCpu<T>(req: PageRequestLike, run: () => Promise<T>): Promise<T> {
  if (typeof window !== 'undefined') return run();
  const start = cpuNow();
  try {
    return await run();
  } finally {
    if (start) recordRequestCpu(req, start);
  }
}

function recordRequestCpu(req: PageRequestLike, start: NodeJS.CpuUsage) {
  try {
    recordCpu(req[PAGE_ROUTE_REQ_KEY], 'data', ssrRequestKind(req), start);
  } catch {
    // Losing one sample is fine.
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

function recordCpu(
  route: string | undefined,
  phase: SsrCpuPhase,
  kind: SsrRequestKind,
  start: NodeJS.CpuUsage
) {
  try {
    const { user, system } = process.threadCpuUsage(start);
    cpuSecondsCounter().inc({ route: pageRouteLabel(route), phase, kind }, (user + system) / 1e6);
  } catch {
    // Losing one sample is fine.
  }
}
