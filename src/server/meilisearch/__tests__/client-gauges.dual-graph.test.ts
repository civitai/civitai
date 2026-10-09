import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type promClient from 'prom-client';
import type * as MeiliClient from '~/server/meilisearch/client';

// The Meili wrapper gauges (meili_call_active, meili_call_queue_depth, meili_circuit_state)
// read 0 in production for every pod over a 15-day window that included a six-day brownout
// with ~108k circuit trips. This suite reproduces how production loads the module.
//
// Production loads client.ts twice in one Node process. The Turbopack server build has two
// runtimes, `chunks/` (API routes + instrumentation) and `chunks/ssr/` (page SSR). Each one
// keeps its own module cache, and each emits its own copy of client.ts. prom-client is
// externalized, so both copies register into ONE default registry. The first copy to evaluate
// (the API routes, which the warmer hits first) creates the gauges. When the second copy (SSR,
// warmed last via `/`) evaluates, `registerGaugeWithLabels` hits "already registered" and hands
// back the SAME gauge object. That copy then reassigns `.collect` to a closure over ITS OWN
// limiters and circuits, which are idle on a pod whose Meili traffic arrives through the API
// routes. Counters still work because both copies increment the one shared object. Only the
// collect()-based gauges go blind.
//
// Vitest normally loads each module once, which hides this defect. Here `vi.resetModules()`
// between two imports builds the second copy. prom-client is a node_modules dependency that
// Vitest externalizes, so Node's own module cache keeps ONE instance across the reset. That
// matches the externalized package in production. Nothing in this file forces it. The
// PRECONDITION test asserts the sharing by object identity, so a future harness change that gave
// each copy its own registry fails there loudly rather than silently changing what this suite
// models.

// The REAL registration helpers. `~/server/prom/client` re-exports these from
// @civitai/telemetry/client, and they are what client.ts calls. The global test setup stubs them
// out, and that stub would hide the duplicate-registration path this suite exists to exercise.
vi.mock('~/server/prom/client', async () => await vi.importActual('@civitai/telemetry/client'));

vi.mock('~/env/server', () => ({
  env: {
    SEARCH_HOST: 'http://meili-search.example',
    SEARCH_API_KEY: 'test-search-key',
    METRICS_SEARCH_HOST: 'http://meili-metrics.example',
    METRICS_SEARCH_API_KEY: 'test-metrics-key',
    IS_BUILD: false,
    MEILI_CALL_TIMEOUT_MS: 1000,
    // Small enough that 3 calls give active=2 and queued=1. Those values differ from each
    // other and from 0, so a gauge that reports a constant cannot satisfy them.
    MEILI_CALL_CONCURRENCY: 2,
    MEILI_RESOURCE_SELECT_CONCURRENCY: 500,
    MEILI_RESOURCE_SELECT_TIMEOUT_MS: 100,
    MEILI_CIRCUIT_TRIP_THRESHOLD: 1,
    MEILI_CIRCUIT_WINDOW_SECONDS: 30,
    MEILI_CIRCUIT_COOLDOWN_SECONDS: 30,
    MEILI_FETCH_TIMEOUT_MS: 5000,
  },
}));

vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: <T>(_name: string, _attrsOrFn: unknown, maybeFn?: () => T): T => {
    const fn = (typeof _attrsOrFn === 'function' ? _attrsOrFn : maybeFn) as () => T;
    return fn();
  },
  safeUrl: (u: string) => u,
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => () => undefined,
}));

// Type-only: erased at build, so neither import loads a module copy of its own.
type ClientModule = typeof MeiliClient;
type PromClient = typeof promClient;

async function loadPromClient(): Promise<PromClient> {
  return ((await import('prom-client')) as unknown as { default: PromClient }).default;
}

/** Scrape one gauge the way /api/metrics does — through the shared default registry. */
async function gaugeValue(name: string, backend: string): Promise<number | undefined> {
  const client = await loadPromClient();
  const metric = client.register.getSingleMetric(`civitai_app_${name}`);
  if (!metric) throw new Error(`civitai_app_${name} is not registered`);
  const { values } = await metric.get();
  return values.find((v) => v.labels.backend === backend)?.value;
}

/**
 * Two copies of client.ts in evaluation order: the first stands for the API runtime, which
 * serves the Meili traffic, and the second for the SSR runtime, which evaluates later.
 */
type Registration = {
  prom: PromClient;
  gauge: ReturnType<PromClient['register']['getSingleMetric']>;
};

async function snapshotRegistration(): Promise<Registration> {
  const prom = await loadPromClient();
  const gauge = prom.register.getSingleMetric('civitai_app_meili_call_active');
  return { prom, gauge };
}

async function loadTwoCopies(): Promise<{
  apiCopy: ClientModule;
  ssrCopy: ClientModule;
  afterApi: Registration;
  afterSsr: Registration;
}> {
  const apiCopy = await import('~/server/meilisearch/client');
  const afterApi = await snapshotRegistration();
  vi.resetModules();
  const ssrCopy = await import('~/server/meilisearch/client');
  const afterSsr = await snapshotRegistration();
  return { apiCopy, ssrCopy, afterApi, afterSsr };
}

/** Start `n` calls through `copy` that stay in flight until released. */
function holdCalls(copy: ClientModule, n: number) {
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: n }, () =>
    copy.withMeili('search', () => new Promise<void>((resolve) => releases.push(resolve)))
  );
  return { releases, pending };
}

/**
 * Release held calls one at a time until none are left. The LIVE arrays are passed, never a
 * copy: a queued call only pushes its release once it gets a slot, so a snapshot taken before
 * that would never release it.
 */
async function drain(holds: Array<ReturnType<typeof holdCalls>>) {
  for (;;) {
    const next = holds.find((h) => h.releases.length > 0);
    if (!next) break;
    next.releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
  }
  await Promise.all(holds.flatMap((h) => h.pending));
}

function clearMeiliGlobals() {
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith('__civitaiMeili')) delete (globalThis as Record<string, unknown>)[key];
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  clearMeiliGlobals();
  (await loadPromClient()).register.clear();
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  clearMeiliGlobals();
  (await loadPromClient()).register.clear();
});

describe('meili wrapper gauges with two module copies (the production load shape)', () => {
  // Harness facts only. This must hold for ANY correct client.ts, so it asserts nothing about
  // which copy's collect() is installed. A fix that keeps the first copy's hook is just as valid.
  it('PRECONDITION: two module copies share ONE prom-client and ONE gauge object', async () => {
    const { apiCopy, ssrCopy, afterApi, afterSsr } = await loadTwoCopies();
    // Two distinct module instances were built...
    expect(apiCopy).not.toBe(ssrCopy);
    expect(apiCopy.withMeili).not.toBe(ssrCopy.withMeili);
    // ...over the SAME prom-client instance, so the same default registry...
    expect(afterSsr.prom).toBe(afterApi.prom);
    // ...where the second copy got the FIRST copy's gauge object back ("already registered").
    expect(afterApi.gauge).toBeTruthy();
    expect(afterSsr.gauge).toBe(afterApi.gauge);
  });

  it('CONTROL: with ONE copy loaded, the harness observes live non-zero gauge values', async () => {
    // This passes with or without the fix. It shows that the harness can read a non-zero gauge,
    // so a red result in the two-copy tests below comes from the second copy and not from a
    // scrape path that only ever returns 0.
    const only = await import('~/server/meilisearch/client');
    const releases: Array<() => void> = [];
    const pending = [1, 2, 3].map(() =>
      only.withMeili('search', () => new Promise<void>((resolve) => releases.push(resolve)))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await gaugeValue('meili_call_active', 'search')).toBe(2);
    expect(await gaugeValue('meili_call_queue_depth', 'search')).toBe(1);
    while (releases.length) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(pending);
  });

  it('meili_call_active / meili_call_queue_depth report calls made through the FIRST copy', async () => {
    const { apiCopy } = await loadTwoCopies();

    const releases: Array<() => void> = [];
    const pending = [1, 2, 3].map(() =>
      apiCopy.withMeili('search', () => new Promise<void>((resolve) => releases.push(resolve)))
    );
    // Let p-limit start the first two tasks; the third waits in its queue.
    await vi.advanceTimersByTimeAsync(0);

    expect(await gaugeValue('meili_call_active', 'search')).toBe(2);
    expect(await gaugeValue('meili_call_queue_depth', 'search')).toBe(1);
    // The idle backend stays at 0, so the reading is per backend, not one number copied to
    // every label.
    expect(await gaugeValue('meili_call_active', 'metricsSearch')).toBe(0);

    // Drain, and check the gauges follow the live state back down. A value latched at its
    // first reading fails here.
    while (releases.length) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(pending);
    expect(await gaugeValue('meili_call_active', 'search')).toBe(0);
    expect(await gaugeValue('meili_call_queue_depth', 'search')).toBe(0);
  });

  it('both copies share ONE per-backend concurrency cap, and the gauges count calls from either copy', async () => {
    const { apiCopy, ssrCopy } = await loadTwoCopies();

    // Fill the cap (2) through the first copy, then call through the second copy. With a
    // per-process cap the second copy's call has to queue. A private per-copy limiter would run
    // it at once (active=3, queued=0).
    const api = holdCalls(apiCopy, 2);
    const ssr = holdCalls(ssrCopy, 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(await gaugeValue('meili_call_active', 'search')).toBe(2);
    expect(await gaugeValue('meili_call_queue_depth', 'search')).toBe(1);

    await drain([api, ssr]);
    expect(await gaugeValue('meili_call_active', 'search')).toBe(0);
    expect(await gaugeValue('meili_call_queue_depth', 'search')).toBe(0);
  });

  it('meili_circuit_state reports OPEN (2) after the FIRST copy trips its circuit', async () => {
    const { apiCopy } = await loadTwoCopies();

    // CLOSED reads 0. Asserting it first means a gauge stuck on 2 cannot pass.
    expect(await gaugeValue('meili_circuit_state', 'search')).toBe(0);

    // One timeout with TRIP_THRESHOLD=1 trips the breaker.
    const hung = apiCopy.withMeili('search', () => new Promise<never>(() => undefined));
    const settled = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toBeInstanceOf(apiCopy.MeiliCallTimeoutError);

    expect(await gaugeValue('meili_circuit_state', 'search')).toBe(2);
    expect(await gaugeValue('meili_circuit_state', 'metricsSearch')).toBe(0);
  });

  it('both copies admit against ONE circuit: a trip seen through one copy fails fast in the other', async () => {
    const { apiCopy, ssrCopy } = await loadTwoCopies();

    const hung = apiCopy.withMeili('search', () => new Promise<never>(() => undefined));
    const settled = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    const fn = vi.fn(async () => 'ok');
    await expect(ssrCopy.withMeili('search', fn)).rejects.toMatchObject({
      reason: 'concurrency',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
