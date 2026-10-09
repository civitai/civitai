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
// between two imports builds the second copy. Mocking `prom-client` with its own
// implementation keeps one instance across the reset, so both copies share one registry the
// way the externalized package does in production. The precondition test below checks that
// sharing, so a harness that silently gave each copy its own registry cannot pass vacuously.

vi.mock('prom-client', async (importOriginal) => await importOriginal());

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
async function loadTwoCopies(): Promise<{ apiCopy: ClientModule; ssrCopy: ClientModule }> {
  const apiCopy = await import('~/server/meilisearch/client');
  vi.resetModules();
  const ssrCopy = await import('~/server/meilisearch/client');
  return { apiCopy, ssrCopy };
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
  it('PRECONDITION: both copies register into ONE shared registry (else this suite proves nothing)', async () => {
    const { apiCopy, ssrCopy } = await loadTwoCopies();
    // Proves two distinct module instances were built...
    expect(apiCopy).not.toBe(ssrCopy);
    expect(apiCopy.withMeili).not.toBe(ssrCopy.withMeili);
    // ...and that they met in ONE registry. One registered metric with that name, not two
    // registries each holding their own.
    const client = await loadPromClient();
    const names = (await client.register.getMetricsAsJSON()).map((m) => m.name);
    expect(names.filter((n) => n === 'civitai_app_meili_call_active')).toHaveLength(1);
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
