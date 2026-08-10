import type { NextApiResponse } from 'next';
import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * 🔴 THE SEAM: `$metrics` is a Prisma PREVIEW feature, so it is one schema or
 * engine change away from throwing (under `queryCompiler` its implementation is
 * a bare `throw new Error("Method not implemented.")`). Awaiting it unguarded
 * put the ENTIRE scrape behind it — default metrics, the instrumentation
 * registry, and every counter the page's side-effect imports exist to seed.
 *
 * A revert makes tests 1 and 2 reject with the thrown message, in ~1s. Nothing
 * here loops or waits on a timer.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper
// so none of that graph is needed. Same seam as
// src/server/metrics/__tests__/metrics-endpoint-seeds-substitutions.test.ts.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

// src/__tests__/setup.ts wholesale-mocks this module and omits
// `instrumentationRegistry`, which the handler scrapes.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
}));

const readPrometheus = vi.fn();
const writePrometheus = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { $metrics: { prometheus: (...args: unknown[]) => readPrometheus(...args) } },
  dbWrite: { $metrics: { prometheus: (...args: unknown[]) => writePrometheus(...args) } },
}));

type Handler = (req: unknown, res: NextApiResponse) => Promise<void> | void;

const FAILURES = 'prisma_metrics_scrape_failures_total';

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

/** The counter is module-scoped and cumulative across this file, so assert deltas. */
async function failureCounts(): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric(FAILURES) as unknown as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return {};
  const { values } = await metric.get();
  return Object.fromEntries(values.map((v) => [v.labels.type, v.value]));
}

describe('/api/metrics survives a throwing PrismaClient.$metrics', () => {
  beforeEach(() => {
    readPrometheus.mockReset();
    writePrometheus.mockReset();
  });

  it('🔴 still serves the non-Prisma series when dbRead.$metrics rejects', async () => {
    readPrometheus.mockRejectedValue(new Error('Method not implemented.'));
    writePrometheus.mockResolvedValue('civitai_write_prisma_series 1');

    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    expect(state.headers['Content-type']).toBe(client.register.contentType);
    expect(state.body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
    expect(state.body).toContain('civitai_write_prisma_series 1');
  });

  it('🔴 survives a SYNCHRONOUS throw, not just a rejection', async () => {
    readPrometheus.mockImplementation(() => {
      throw new Error('Method not implemented.');
    });
    writePrometheus.mockResolvedValue('');

    const handler = await loadHandler();
    const { res, state } = fakeRes();
    await handler({}, res);

    expect(state.body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
  });

  it('counts only the failing client', async () => {
    readPrometheus.mockRejectedValue(new Error('Method not implemented.'));
    writePrometheus.mockResolvedValue('');

    const handler = await loadHandler();
    const before = await failureCounts();
    const { res } = fakeRes();
    await handler({}, res);
    const after = await failureCounts();

    expect(after.read - before.read).toBe(1);
    expect(after.write - before.write).toBe(0);
  });

  it('NEGATIVE CONTROL: two healthy clients increment nothing and both bodies land', async () => {
    readPrometheus.mockResolvedValue('r 1');
    writePrometheus.mockResolvedValue('w 1');

    const handler = await loadHandler();
    const before = await failureCounts();
    const { res, state } = fakeRes();
    await handler({}, res);
    const after = await failureCounts();

    expect(state.body).toContain('r 1');
    expect(state.body).toContain('w 1');
    expect(after.read - before.read).toBe(0);
    expect(after.write - before.write).toBe(0);
  });

  it('seeds both label values at 0 on module load, so a healthy pod is not `no data`', async () => {
    await loadHandler();
    expect(await failureCounts()).toMatchObject({
      read: expect.any(Number),
      write: expect.any(Number),
    });
  });
});
