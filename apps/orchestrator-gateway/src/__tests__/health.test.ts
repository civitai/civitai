import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../app';

// /health is the no-auth k8s liveness+readiness probe. It must be a plain 200 with no dependency on tRPC,
// DB, or redis (so a transient backend blip can't flap the pod).
describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with an ok status body', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'orchestrator-gateway' });
  });
});

describe('GET /metrics', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the prometheus registry when scraped in-cluster (no x-forwarded-for)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    // The pre-declared counters export their baseline before any event.
    expect(res.body).toContain('orchestrator_gateway_trpc_calls_total');
    expect(res.body).toContain('orchestrator_gateway_auth_outcomes_total');
  });

  it('404s a public request (one carrying x-forwarded-for from the ingress)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.statusCode).toBe(404);
  });
});
