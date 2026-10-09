import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type promClient from 'prom-client';
import type * as SignalsWrapper from '~/server/signals/wrapper';

// The production server build evaluates src/server/signals/wrapper.ts TWICE in one Node
// process: Turbopack emits it as one runtime module per runtime (`chunks/` for API routes +
// instrumentation, `chunks/ssr/` for page SSR — measured on a local production build: one
// module id under each), and each runtime keeps its own module cache. prom-client is
// externalized, so both copies register into ONE default registry. With module-scope state
// each copy had its own limiters, queue bounds and circuit — every per-lane limit applied per
// copy, a trip seen through one copy never failed calls through the other — and the
// collect()-based gauges read whichever copy owned the hook. This suite reproduces that load
// shape: `vi.resetModules()` between two imports builds a second copy, while prom-client (a
// node_modules dependency Vitest externalizes) stays ONE instance, as in production. The
// PRECONDITION test asserts that sharing by object identity, so a harness change that gave
// each copy its own registry fails loudly instead of silently changing what this models.
// Mirrors src/server/meilisearch/__tests__/client-gauges.dual-graph.test.ts.

// The REAL registration helpers: `~/server/prom/client` re-exports them from
// @civitai/telemetry/client, and they are what wrapper.ts calls. A stub would hide the
// "already registered" path this suite exists to exercise.
vi.mock('~/server/prom/client', async () => await vi.importActual('@civitai/telemetry/client'));

vi.mock('~/env/server', () => ({
  env: {
    SIGNALS_CALL_TIMEOUT_MS: 1000,
    // Small enough that 3 calls give active=2 and queued=1 — values distinct from each other
    // and from 0, so a gauge reporting a constant cannot satisfy them.
    SIGNALS_CALL_CONCURRENCY: 2,
    SIGNALS_CALL_MAX_QUEUE: 50,
    SIGNALS_TOKEN_CALL_CONCURRENCY: 2,
    SIGNALS_TOKEN_CALL_MAX_QUEUE: 50,
    SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
    SIGNALS_CIRCUIT_WINDOW_SECONDS: 60,
    SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 30,
  },
}));

vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

// Type-only: erased at build, so neither import loads a module copy of its own.
type WrapperModule = typeof SignalsWrapper;
type PromClient = typeof promClient;

async function loadPromClient(): Promise<PromClient> {
  return ((await import('prom-client')) as unknown as { default: PromClient }).default;
}

/** Scrape one gauge the way /api/metrics does — through the shared default registry. */
async function gaugeValue(name: string, lane?: string): Promise<number | undefined> {
  const client = await loadPromClient();
  const metric = client.register.getSingleMetric(`civitai_app_${name}`);
  if (!metric) throw new Error(`civitai_app_${name} is not registered`);
  const { values } = await metric.get();
  return lane === undefined ? values[0]?.value : values.find((v) => v.labels.lane === lane)?.value;
}

async function loadTwoCopies() {
  const apiCopy: WrapperModule = await import('~/server/signals/wrapper');
  const promAfterApi = await loadPromClient();
  const gaugeAfterApi = promAfterApi.register.getSingleMetric('civitai_app_signals_call_active');
  vi.resetModules();
  const ssrCopy: WrapperModule = await import('~/server/signals/wrapper');
  const promAfterSsr = await loadPromClient();
  const gaugeAfterSsr = promAfterSsr.register.getSingleMetric('civitai_app_signals_call_active');
  return { apiCopy, ssrCopy, promAfterApi, promAfterSsr, gaugeAfterApi, gaugeAfterSsr };
}

/** Start `n` calls through `copy` that stay in flight until released. */
function holdCalls(copy: WrapperModule, n: number, lane?: 'default' | 'token') {
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: n }, () =>
    copy.withSignals(() => new Promise<void>((resolve) => releases.push(resolve)), { lane })
  );
  return { releases, pending };
}

/**
 * Release held calls one at a time until none are left. The LIVE arrays are passed: a queued
 * call only pushes its release once it gets a slot.
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

function clearSignalsGlobals() {
  for (const key of Object.keys(globalThis)) {
    // `signalsWrapperGaugesRegistered` is the first-copy-wins registration flag an older
    // wrapper kept on globalThis; clearing it lets that version register as it would in a
    // fresh process, so this suite measures it fairly rather than failing on a leaked flag.
    if (key.startsWith('__civitaiSignals') || key === 'signalsWrapperGaugesRegistered') {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  clearSignalsGlobals();
  (await loadPromClient()).register.clear();
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  clearSignalsGlobals();
  (await loadPromClient()).register.clear();
});

describe('signals wrapper with two module copies (the production load shape)', () => {
  // Harness facts only — must hold for ANY correct wrapper.ts.
  it('PRECONDITION: two module copies share ONE prom-client and ONE gauge object', async () => {
    const c = await loadTwoCopies();
    expect(c.apiCopy).not.toBe(c.ssrCopy);
    expect(c.apiCopy.withSignals).not.toBe(c.ssrCopy.withSignals);
    expect(c.promAfterSsr).toBe(c.promAfterApi);
    expect(c.gaugeAfterApi).toBeTruthy();
    expect(c.gaugeAfterSsr).toBe(c.gaugeAfterApi);
  });

  it('CONTROL: with ONE copy loaded, the harness observes live non-zero gauge values', async () => {
    // Passes with or without the fix: proves the scrape path can read non-zero values, so a
    // red result below comes from the second copy, not from a harness that only reads 0.
    const only: WrapperModule = await import('~/server/signals/wrapper');
    const h = holdCalls(only, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(await gaugeValue('signals_call_active', 'default')).toBe(2);
    expect(await gaugeValue('signals_call_queue_depth', 'default')).toBe(1);
    await drain([h]);
  });

  it('the gauges report calls made through the FIRST copy, per lane, and follow them back to 0', async () => {
    const { apiCopy } = await loadTwoCopies();

    const h = holdCalls(apiCopy, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(await gaugeValue('signals_call_active', 'default')).toBe(2);
    expect(await gaugeValue('signals_call_queue_depth', 'default')).toBe(1);
    // The idle lane stays 0: the reading is per lane, not one number on every label.
    expect(await gaugeValue('signals_call_active', 'token')).toBe(0);

    await drain([h]);
    expect(await gaugeValue('signals_call_active', 'default')).toBe(0);
    expect(await gaugeValue('signals_call_queue_depth', 'default')).toBe(0);
  });

  it('the gauges report calls made ONLY through the SECOND copy (whichever copy owns the hook)', async () => {
    const { ssrCopy } = await loadTwoCopies();

    const h = holdCalls(ssrCopy, 3, 'token');
    await vi.advanceTimersByTimeAsync(0);
    expect(await gaugeValue('signals_call_active', 'token')).toBe(2);
    expect(await gaugeValue('signals_call_queue_depth', 'token')).toBe(1);

    await drain([h]);
    expect(await gaugeValue('signals_call_active', 'token')).toBe(0);
  });

  it.each(['default', 'token'] as const)(
    "both copies share ONE '%s'-lane concurrency cap, and the gauges count calls from either copy",
    async (lane) => {
      const { apiCopy, ssrCopy } = await loadTwoCopies();

      // Fill the lane's cap (2) through the first copy, then call through the second. With a
      // per-process cap the second copy's call has to queue; a private per-copy limiter would
      // run it at once (active=3, queued=0).
      const api = holdCalls(apiCopy, 2, lane);
      const ssr = holdCalls(ssrCopy, 1, lane);
      await vi.advanceTimersByTimeAsync(0);

      expect(await gaugeValue('signals_call_active', lane)).toBe(2);
      expect(await gaugeValue('signals_call_queue_depth', lane)).toBe(1);
      expect(ssr.releases).toHaveLength(0); // the second copy's call did not start

      await drain([api, ssr]);
      expect(await gaugeValue('signals_call_active', lane)).toBe(0);
      expect(await gaugeValue('signals_call_queue_depth', lane)).toBe(0);
    }
  );

  it('signals_circuit_state reports OPEN (2) after the FIRST copy trips the circuit', async () => {
    const { apiCopy } = await loadTwoCopies();

    // CLOSED reads 0 — asserting it first means a gauge stuck on 2 cannot pass.
    expect(await gaugeValue('signals_circuit_state')).toBe(0);

    const hung = apiCopy.withSignals(() => new Promise<never>(() => undefined));
    const settled = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000); // backend timeout, TRIP_THRESHOLD=1 → OPEN
    expect(await settled).toBeInstanceOf(apiCopy.SignalsCallTimeoutError);

    expect(await gaugeValue('signals_circuit_state')).toBe(2);
  });

  it('both copies admit against ONE circuit: a trip seen through one copy fails fast in the other', async () => {
    const { apiCopy, ssrCopy } = await loadTwoCopies();

    const hung = apiCopy.withSignals(() => new Promise<never>(() => undefined));
    const settled = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    const fn = vi.fn(async () => 'ok');
    await expect(ssrCopy.withSignals(fn)).rejects.toThrow(/circuit open/);
    expect(fn).not.toHaveBeenCalled();
  });
});
