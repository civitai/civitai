import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type client from 'prom-client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';

// /api/readyz: pod-local readiness. 200 once warm, 503 before, from in-process state only, so a
// dependency outage (which hits every pod at once) can never mark the whole fleet unready.

// db and redis are the shared canonical mocks (src/__tests__/mocks): every call on them is
// recorded, so `calledHybridNodes` lists any the route made. ClickHouse has no canonical mock, so
// it is a trap that throws on first use. fetch is spied per test.
const DEP_ROOTS = ['dbRead', 'dbWrite', 'redis', 'sysRedis', 'withSysReadDeadline'] as const;
const { trap } = vi.hoisted(() => ({
  trap: (name: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          // Probed by module resolution (thenable check); not a real client read.
          if (prop === 'then' || typeof prop === 'symbol' || prop === '__esModule')
            return undefined;
          throw new Error(`readyz must not touch ${name} (accessed "${String(prop)}")`);
        },
      }
    ),
}));
vi.mock('~/server/clickhouse/client', () => trap('clickhouse'));

// The full dependency check. Mocked to report every dependency failing: readyz must still be 200.
const { runHealthChecks } = vi.hoisted(() => ({
  runHealthChecks: vi.fn(async () => ({
    healthy: false,
    results: { write: { healthy: false }, read: { healthy: false }, redis: { healthy: false } },
  })),
}));
vi.mock('~/pages/api/health', () => ({
  runHealthChecks,
  runHealthChecksReusingCleanRun: runHealthChecks,
}));

// warmup.ts imports instrumentationRegistry, which the global prom mock does not export
// (same override as warmup.test.ts).
const { testRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { testRegistry: new promClient.Registry() as client.Registry };
});
vi.mock('~/server/prom/client', () => ({
  instrumentationRegistry: testRegistry,
  registerInstrumentationMetric: <M extends client.Metric<string>>(name: string, f: () => M): M =>
    (testRegistry.getSingleMetric(name) as unknown as M) ?? f(),
  registerCounter: () => ({ inc: vi.fn() }),
  registerHistogram: () => ({ observe: vi.fn() }),
}));

function createMocks() {
  let statusCode = 0;
  let payload: unknown = undefined;
  const headers: Record<string, string> = {};
  const req = { method: 'GET', headers: {}, query: {} };
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload as Record<string, unknown>,
    _headers: headers,
  };
  return { req, res };
}

async function call(handler: (req: never, res: never) => unknown) {
  const { req, res } = createMocks();
  await handler(req as never, res as never);
  return res;
}

const WARM_ENV = [
  'WARMUP_ENABLED',
  'WARMUP_ROUTES',
  'WARM_INITIAL_JITTER_MAX_MS',
  'WARM_INTER_ROUTE_JITTER_MAX_MS',
] as const;
function clearWarmEnv() {
  for (const k of WARM_ENV) delete process.env[k];
}

let handler: (req: never, res: never) => unknown;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  clearWarmEnv();
  vi.resetModules();
  // A warm pod, written onto the shared global before the modules read it.
  globalThis.__civitaiWarmState = { ready: true, state: 'warmed-ok', durationMs: 1 };
  handler = (await import('~/pages/api/readyz')).default as never;
  runHealthChecks.mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('readyz must not fetch'));
});

afterEach(() => {
  fetchSpy.mockRestore();
  clearWarmEnv();
});

describe('/api/readyz', () => {
  it('is 200 while every dependency check would fail, and never runs them', async () => {
    const res = await call(handler);
    expect(runHealthChecks).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calledHybridNodes(DEP_ROOTS)).toEqual([]);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ready: true });
    expect(res._headers['cache-control']).toBe('no-store');
  });

  it('the dependency instruments can see a call (so the zeros above are not vacuous)', async () => {
    await dbMock.dbRead.user.findFirst();
    expect(calledHybridNodes(DEP_ROOTS)).toEqual(['dbRead.user.findFirst']);
    dbMock.dbRead.user.findFirst.mockClear();
    const ch = (await import('~/server/clickhouse/client')) as Record<string, unknown>;
    expect(() => ch.clickhouse).toThrow(/must not touch clickhouse/);
    await expect(fetch('http://localhost/')).rejects.toThrow(/must not fetch/);
  });

  it('is 503 "cold" before warmup finishes, with no I/O either', async () => {
    globalThis.__civitaiWarmState!.ready = false;
    globalThis.__civitaiWarmState!.state = 'in-progress';
    const res = await call(handler);
    expect(res._status()).toBe(503);
    expect(res._json()).toEqual({ ready: false, reason: 'cold' });
    expect(res._headers['cache-control']).toBe('no-store');
    expect(runHealthChecks).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calledHybridNodes(DEP_ROOTS)).toEqual([]);
  });
});

// The warmer runs from instrumentation, which Next bundles separately from the API routes, so the
// writer and the route each get their own instance of warmup.ts. Reproduce that: import the route,
// reset the module registry, and run the warmer from a second, independent instance. A route
// holding module-local warm state would never see the flip, and every pod would stay 503.
describe('/api/readyz reads warm state written by a separate module instance', () => {
  beforeEach(() => {
    delete globalThis.__civitaiWarmState;
  });

  it('flips to 200 when the other instance finishes warmup (warmer disabled)', async () => {
    vi.resetModules();
    const routeHandler = (await import('~/pages/api/readyz')).default as never;
    expect((await call(routeHandler))._status()).toBe(503);

    vi.resetModules();
    await (await import('~/server/warmup')).runWarmup();
    expect((await call(routeHandler))._status()).toBe(200);
  });

  // The standalone server (scripts/trpc-server, both profiles) runs the same instrumentation
  // register(), so the same warmer. It serves /api/live, which the warmer polls for the listener,
  // but not most warm routes (SSR, and /api/v1/ under the trpc profile): those answer 404 there.
  // Warmup must still complete and flip warm, or readyz would be 503 forever on that server.
  it('flips to 200 when warmup is enabled and every warm route 404s (standalone server shape)', async () => {
    vi.resetModules();
    const routeHandler = (await import('~/pages/api/readyz')).default as never;
    expect((await call(routeHandler))._status()).toBe(503);

    process.env.WARMUP_ENABLED = 'true';
    process.env.WARM_INITIAL_JITTER_MAX_MS = '0';
    process.env.WARM_INTER_ROUTE_JITTER_MAX_MS = '0';
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return new Response('', { status: url.includes('/api/live') ? 200 : 404 });
    });

    vi.resetModules();
    const writer = await import('~/server/warmup');
    await writer.runWarmup();

    // The warmer really ran and was answered 404 on its routes (not the disabled no-op).
    expect(writer.getWarmState()).toBe('warmed-ok');
    expect(urls.filter((u) => !u.includes('/api/live')).length).toBeGreaterThan(0);
    expect((await call(routeHandler))._status()).toBe(200);
  });
});
