import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../app';

// These exercise the routes that DON'T touch the DB/redis (health, metrics, auth gate, validation), so
// no live infra is needed. The create path (settings read + upsert) is covered by an integration run.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns ok without touching any dependency', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'notifications' });
  });
});

describe('GET /metrics', () => {
  it('serves prometheus text to an in-cluster scrape (no XFF)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('notifications_producer_requests_total');
  });

  it('404s a request that came through the public ingress (XFF present)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /notifications validation', () => {
  it('rejects an invalid payload with 400 (before any DB work)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      payload: { type: 'new-comment' }, // missing key/category/details
    });
    expect(res.statusCode).toBe(400);
  });
});
