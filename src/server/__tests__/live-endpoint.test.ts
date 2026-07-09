import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal NextApiRequest/Response stand-in (avoids a node-mocks-http dependency).
// Mirrors src/server/utils/__tests__/retool-endpoint.test.ts.
function createMocks({
  method = 'GET',
  headers = {},
  query = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
} = {}) {
  const req = { method, headers, query } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
  };
  return { req, res };
}

// The whole point of this suite: the liveness handler must NEVER touch any Redis
// client (cluster `redis` OR sentinel/standalone `sysRedis`). If it did, a
// sysRedis Sentinel reconnect blip (topology churn during the HA cutover) would
// fail the liveness probe and kubelet would SIGTERM the pod — turning a
// fail-open cache hiccup into a pod restart. We enforce this STRUCTURALLY: mock
// `~/server/redis/client` so ANY property access throws. If `live.ts` ever
// reaches for a redis client, importing/handling will throw and the test fails.
const redisTrap = new Proxy(
  {},
  {
    get(_t, prop) {
      // `then` / Symbol.toStringTag etc. are probed by the ESM module-resolution
      // machinery (a module namespace is checked for thenable-ness). Let those
      // pass through as undefined so the mock resolves as a normal (non-thenable)
      // module; trap only REAL client property reads (sysRedis, redis, …).
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      throw new Error(
        `liveness handler must not touch redis client (accessed "${String(prop)}")`
      );
    },
  }
);

vi.mock('~/server/redis/client', () => redisTrap);

// Keep the endpoint-helpers import chain out of the test (it pulls env + axiom +
// prom + the full db/auth tree). Provide a faithful token-gated WebhookEndpoint
// so the test still exercises the real auth shape of the route.
const TEST_TOKEN = 'test-webhook-token';
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint:
    (handler: (req: unknown, res: unknown) => Promise<void>) =>
    async (req: any, res: any) => {
      if (req.query?.token !== TEST_TOKEN) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      await handler(req, res);
    },
}));

import liveHandler from '~/pages/api/live';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/live (liveness probe)', () => {
  it('returns 200 with alive:true on a valid token', async () => {
    const { req, res } = createMocks({ query: { token: TEST_TOKEN } });
    await liveHandler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ alive: true });
  });

  it('stays 200 even though the redis client module would throw on any access', async () => {
    // redisTrap throws on EVERY property read; reaching 200 proves the handler
    // never dereferenced sysRedis / redis. This is the regression guard for the
    // sysRedis-HA-cutover restart risk: liveness is dependency-free.
    const { req, res } = createMocks({ query: { token: TEST_TOKEN } });
    await expect(liveHandler(req as never, res as never)).resolves.not.toThrow();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ alive: true });
  });

  it('directly accessing the trapped redis module throws (proves the trap is armed)', async () => {
    // Sanity check that the structural guard above is real, not vacuous: if the
    // handler HAD touched the redis client, it would have thrown like this.
    const mod = (await import('~/server/redis/client')) as Record<string, unknown>;
    expect(() => mod.sysRedis).toThrow(/must not touch redis client/);
    expect(() => mod.redis).toThrow(/must not touch redis client/);
  });

  it('still token-gates (401 without the token)', async () => {
    const { req, res } = createMocks({ query: {} });
    await liveHandler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
  });
});
