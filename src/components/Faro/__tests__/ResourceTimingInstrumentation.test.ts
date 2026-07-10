import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildResourceTimingInstrumentations,
  ResourceTimingInstrumentation,
} from '../ResourceTimingInstrumentation';
import type { ResourceTimingLike } from '~/utils/faro/resourceTiming';

/**
 * Wiring test for `ResourceTimingInstrumentation`: with a fake `PerformanceObserver` +
 * `window` + Faro api, assert it observes `resource` (buffered), filters to same-origin
 * `/api` fetch/xhr, emits the privacy-safe measurement shape, and honours the volume gate.
 * The phase math / route normalization / privacy scrub are covered exhaustively in
 * `~/utils/faro/__tests__/resourceTiming.test.ts`; this covers the SDK plumbing.
 */

const ORIGIN = 'https://civitai.com';

type ObserverInit = { type: string; buffered?: boolean };
let observerCallback: ((list: { getEntries: () => unknown[] }) => void) | undefined;
let observeArgs: ObserverInit | undefined;

class FakePerformanceObserver {
  constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
    observerCallback = cb;
  }
  observe(init: ObserverInit) {
    observeArgs = init;
  }
  disconnect() {
    // no-op
  }
}

function emitEntries(entries: ResourceTimingLike[]) {
  observerCallback?.({ getEntries: () => entries });
}

function apiEntry(overrides: Partial<ResourceTimingLike> = {}): ResourceTimingLike {
  return {
    name: `${ORIGIN}/api/trpc/model.getById?batch=1`,
    initiatorType: 'fetch',
    nextHopProtocol: 'h2',
    domainLookupStart: 10,
    domainLookupEnd: 25,
    connectStart: 25,
    secureConnectionStart: 40,
    connectEnd: 60,
    requestStart: 60,
    responseStart: 210,
    responseEnd: 260,
    duration: 250,
    ...overrides,
  };
}

/** Attach a mock Faro api + deterministic gate to an instrumentation instance. */
function makeInstrumentation(pushMeasurement: ReturnType<typeof vi.fn>) {
  const inst = new ResourceTimingInstrumentation({
    maxPerWindow: 2,
    windowMs: 1000,
    sampleRate: 1, // no sampling in the plumbing test — assert exact emissions
    now: () => 0,
  });
  (inst as unknown as { api: { pushMeasurement: unknown } }).api = { pushMeasurement };
  return inst;
}

describe('ResourceTimingInstrumentation', () => {
  beforeEach(() => {
    observerCallback = undefined;
    observeArgs = undefined;
    (globalThis as unknown as { window: unknown }).window = { location: { origin: ORIGIN } };
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      FakePerformanceObserver;
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { PerformanceObserver?: unknown }).PerformanceObserver;
  });

  it('observes the resource entry type with buffered:true', () => {
    makeInstrumentation(vi.fn()).initialize();
    expect(observeArgs).toEqual({ type: 'resource', buffered: true });
  });

  it('emits one privacy-safe measurement per same-origin /api entry', () => {
    const push = vi.fn();
    makeInstrumentation(push).initialize();

    emitEntries([apiEntry()]);

    expect(push).toHaveBeenCalledTimes(1);
    const [payload, options] = push.mock.calls[0];
    expect(payload.type).toBe('resource_timing');
    expect(payload.values.rt_ttfb).toBe(150);
    expect(payload.values.rt_dns).toBe(15);
    expect(options.context).toEqual({ route: '/api/trpc', protocol: 'h2' });
    // No URL/query anywhere in what we emit.
    expect(JSON.stringify(push.mock.calls[0])).not.toContain('model.getById');
    expect(JSON.stringify(push.mock.calls[0])).not.toContain('batch=1');
  });

  it('ignores third-party and non-/api resources (no emission)', () => {
    const push = vi.fn();
    makeInstrumentation(push).initialize();

    emitEntries([
      apiEntry({ name: 'https://api.stripe.com/v1/charges', initiatorType: 'fetch' }),
      apiEntry({ name: `${ORIGIN}/models/123`, initiatorType: 'fetch' }),
      apiEntry({ name: `${ORIGIN}/api/trpc/x`, initiatorType: 'img' }),
    ]);

    expect(push).not.toHaveBeenCalled();
  });

  it('applies the per-window volume cap across a burst', () => {
    const push = vi.fn();
    makeInstrumentation(push).initialize(); // maxPerWindow: 2, frozen clock

    emitEntries([apiEntry(), apiEntry(), apiEntry(), apiEntry()]);

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('never throws if the api push fails (RUM must not break the page)', () => {
    const push = vi.fn(() => {
      throw new Error('transport down');
    });
    makeInstrumentation(push).initialize();
    expect(() => emitEntries([apiEntry()])).not.toThrow();
  });

  it('is a no-op when PerformanceObserver is unavailable', () => {
    delete (globalThis as unknown as { PerformanceObserver?: unknown }).PerformanceObserver;
    const push = vi.fn();
    // Should not throw during initialize; nothing to observe.
    expect(() => makeInstrumentation(push).initialize()).not.toThrow();
  });
});

describe('buildResourceTimingInstrumentations — the two-gate cohort ramp', () => {
  // This is the EXACT decision FaroProvider spreads into the Faro `instrumentations` list, so
  // these assertions are load-bearing on the production wiring. resource_timing attaches ONLY
  // when BOTH the build-arg AND the `faro-resource-timing` Flipt cohort flag are true (AND).
  it('attaches the instrumentation when BOTH build-arg and cohort flag are true', () => {
    const list = buildResourceTimingInstrumentations({
      buildArgEnabled: true,
      cohortEnabled: true,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toBeInstanceOf(ResourceTimingInstrumentation);
  });

  it('excludes it when the cohort flag is false even though the build-arg is on', () => {
    expect(
      buildResourceTimingInstrumentations({ buildArgEnabled: true, cohortEnabled: false })
    ).toEqual([]);
  });

  it('excludes it when the build-arg is off even though the cohort flag is on', () => {
    expect(
      buildResourceTimingInstrumentations({ buildArgEnabled: false, cohortEnabled: true })
    ).toEqual([]);
  });

  it('excludes it when both gates are false', () => {
    expect(
      buildResourceTimingInstrumentations({ buildArgEnabled: false, cohortEnabled: false })
    ).toEqual([]);
  });

  it('passes the env-tunable volume knobs through to the instrumentation when attached', () => {
    // A valid sample-rate/cap env resolves without throwing and yields exactly one instrumentation
    // (the env-parse-with-fallback itself is covered in resourceTiming.test.ts).
    const list = buildResourceTimingInstrumentations({
      buildArgEnabled: true,
      cohortEnabled: true,
      sampleRateEnv: '0.2',
      maxPerWindowEnv: '16',
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toBeInstanceOf(ResourceTimingInstrumentation);
  });
});
