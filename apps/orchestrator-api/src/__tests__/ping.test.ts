import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock the auth verifier module so tests control the verified claims without wiring real JWKS/redis.
// A bearer token of 'valid-token' resolves to userId 12345 (via claims.sub); anything else → null (reject).
vi.mock('../lib/server/auth/verifier', () => ({
  verifier: {
    verifyToken: vi.fn(async (token: string) =>
      token === 'valid-token' ? { sub: '12345', jti: 'sess-1' } : null
    ),
    getSession: vi.fn(async () => null),
    requireAuth: vi.fn(),
  },
}));

// Import AFTER the mock is registered so context.ts binds to the mocked verifier.
const { buildServer } = await import('../app');

// Helper: call a tRPC query over the fetch adapter mount. tRPC v11 query input goes in the query string.
async function callTrpc(app: FastifyInstance, path: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/trpc/${path}`,
    headers,
  });
}

describe('tRPC orchestrator.ping (protected)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated call with UNAUTHORIZED', async () => {
    const res = await callTrpc(app, 'orchestrator.ping');
    // tRPC serializes the error into the JSON envelope; the HTTP status for UNAUTHORIZED is 401.
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(JSON.stringify(body)).toContain('UNAUTHORIZED');
  });

  it('returns the verified userId for a valid bearer token', async () => {
    const res = await callTrpc(app, 'orchestrator.ping', {
      authorization: 'Bearer valid-token',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // tRPC v11 success envelope: { result: { data: <value> } }
    expect(body.result.data).toEqual({ userId: 12345 });
  });
});

describe('tRPC orchestrator.health (public)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is reachable without auth', async () => {
    const res = await callTrpc(app, 'orchestrator.health');
    expect(res.statusCode).toBe(200);
    expect(res.json().result.data).toEqual({ status: 'ok', service: 'orchestrator-api' });
  });
});
