import type { NextApiResponse } from 'next';
import client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * 🔴 THE SEAM: `Registry.metrics()` is a `Promise.all` over every registered metric's `get()`, so
 * ONE collect() callback that throws rejects the WHOLE call. The handler awaits both registries, so
 * unguarded that means a single bad gauge read 500s the entire scrape — default metrics, every
 * instrumentation metric, every seeded counter and the Prisma series with it — precisely when you
 * most want to be able to see the pod.
 *
 * This is not hypothetical plumbing: `Gauge.set` throws `TypeError: Value is not a valid number` on
 * a non-number, and a collect() body is ordinary application code reading live state. The sibling
 * suite metrics-endpoint-prisma-failure.test.ts covers the same shape one level down.
 *
 * A revert (dropping `collectRegistryMetrics` and awaiting `registry.metrics()` directly) makes
 * tests 1-3 reject with the thrown message. Nothing here loops or waits on a timer.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper so none of that
// graph is needed. Same seam as the sibling suite.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

// src/__tests__/setup.ts wholesale-mocks this module and omits `instrumentationRegistry`, which the
// handler scrapes.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
}));

type Handler = (req: unknown, res: NextApiResponse) => Promise<void> | void;
const FAILURES = 'registry_scrape_failures_total';

function fakeRes() {
  const state = { body: '', headers: {} as Record<string, string> };
  const res = {
    setHeader: (key: string, value: string) => {
      state.headers[key] = value;
    },
    send: (body: string) => {
      state.body = body;
    },
  } as unknown as NextApiResponse;
  return { res, state };
}

async function loadHandler() {
  const mod = await import('~/pages/api/metrics');
  return mod.default as unknown as Handler;
}

/**
 * Reads the counter off whichever registry currently holds it, rather than assuming one. The
 * counter deliberately lives on `instrumentationRegistry` (so a default-registry failure stays
 * observable), and hard-coding that here would make this helper silently return `{}` — i.e. a
 * confident zero — if it ever moved.
 */
async function failureCounts(): Promise<Record<string, number>> {
  const { instrumentationRegistry } = await import('~/server/prom/client');
  const metric = (instrumentationRegistry.getSingleMetric(FAILURES) ??
    client.register.getSingleMetric(FAILURES)) as unknown as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return {};
  const { values } = await metric.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.registry), v.value]));
}

/**
 * Plants a gauge whose collect() throws, on the named registry, and returns a disposer. This is the
 * real mechanism — not a stubbed `metrics()` — so the test exercises the same rejection path
 * production would take.
 */
async function plantThrowingCollector(target: 'default' | 'instrumentation', name: string) {
  const { instrumentationRegistry } = await import('~/server/prom/client');
  const registry = target === 'default' ? client.register : instrumentationRegistry;
  new client.Gauge({
    name,
    help: 'a collector that throws, standing in for a bad live read',
    registers: [registry],
    collect() {
      throw new TypeError('Value is not a valid number');
    },
  });
  return () => registry.removeSingleMetric(name);
}

describe('/api/metrics survives a throwing collect() in either registry', () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    dbMock.dbRead.$metrics.prometheus.mockResolvedValue('civitai_read_prisma_series 1');
    dbMock.dbWrite.$metrics.prometheus.mockResolvedValue('civitai_write_prisma_series 1');
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  // POSITIVE CONTROL. Without this, every assertion below is satisfied by a handler that always
  // returns an empty body — "it did not throw" is not the same as "it still served the metrics".
  it('POSITIVE CONTROL: a healthy scrape serves both registries and the Prisma series', async () => {
    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    expect(state.headers['Content-type']).toBe(client.register.contentType);
    expect(state.body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
    expect(state.body).toContain('civitai_read_prisma_series 1');
    expect(state.body).toContain('civitai_write_prisma_series 1');
  });

  it('🔴 still serves the other registry when a DEFAULT-registry collector throws', async () => {
    disposers.push(await plantThrowingCollector('default', 'test_bad_default_collector'));
    const before = await failureCounts();

    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    // The default block is lost, but the response is still served and still carries everything
    // else. Unguarded this call rejects and the endpoint 500s.
    expect(state.headers['Content-type']).toBe(client.register.contentType);
    expect(state.body).toContain('civitai_read_prisma_series 1');
    expect(state.body).toContain(FAILURES);

    const after = await failureCounts();
    expect((after.default ?? 0) - (before.default ?? 0)).toBe(1);
    // The instrumentation registry was healthy — it must NOT be blamed.
    expect((after.instrumentation ?? 0) - (before.instrumentation ?? 0)).toBe(0);
  });

  it('🔴 still serves the other registry when an INSTRUMENTATION collector throws', async () => {
    disposers.push(await plantThrowingCollector('instrumentation', 'test_bad_instr_collector'));
    const before = await failureCounts();

    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    expect(state.body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
    expect(state.body).toContain('civitai_write_prisma_series 1');

    const after = await failureCounts();
    expect((after.instrumentation ?? 0) - (before.instrumentation ?? 0)).toBe(1);
    expect((after.default ?? 0) - (before.default ?? 0)).toBe(0);
  });

  // The counter lives on instrumentationRegistry precisely so that a DEFAULT-registry failure is
  // still reported. If it were registered on the default registry, this series would be dropped by
  // the very failure it counts — a permanently absent metric where a rising one is expected.
  it('🔴 reports a default-registry failure in the SAME response that lost that block', async () => {
    disposers.push(await plantThrowingCollector('default', 'test_bad_default_collector_2'));

    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    expect(state.body).toMatch(new RegExp(`${FAILURES}\\{registry="default"\\} [1-9]`));
  });

  it('seeds both label values so a healthy pod reads 0 rather than no-data', async () => {
    await loadHandler();
    const counts = await failureCounts();

    expect(counts).toHaveProperty('default');
    expect(counts).toHaveProperty('instrumentation');
  });
});
