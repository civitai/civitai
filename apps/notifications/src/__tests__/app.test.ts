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

  it('exposes the signals-delivery + redis-error baseline series (zero before any event)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('notifications_signals_delivery_total');
    expect(res.body).toContain('notifications_redis_errors_total');
    // Pre-initialized outcome/operation series export a 0 baseline.
    expect(res.body).toContain('notifications_signals_delivery_total{outcome="failure"} 0');
    expect(res.body).toContain('notifications_redis_errors_total{operation="get"} 0');
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

describe('HTTP RED histogram', () => {
  it('records a request against the http_request_duration_seconds histogram, labeled by route+outcome', async () => {
    // An invalid POST is rejected at the zod gate (no DB touched) → outcome="rejected".
    await app.inject({
      method: 'POST',
      url: '/notifications',
      payload: { type: 'new-comment' }, // missing key/category/details
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('notifications_http_request_duration_seconds');
    expect(res.body).toContain('route="/notifications"');
    expect(res.body).toContain('outcome="rejected"');
  });

  it('does NOT record the ops routes (/health, /metrics, /pool-stats) in the RED histogram', async () => {
    // Exercise EVERY ops route, including /pool-stats (which the old assertion skipped). All three have
    // real route templates, so if the hook's `startsWith('/notifications')` scope guard were loosened or
    // dropped they WOULD produce a histogram sample — these assertions fail in that case.
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/pool-stats' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // The histogram label set must never carry an ops route.
    expect(res.body).not.toContain('route="/health"');
    expect(res.body).not.toContain('route="/metrics"');
    expect(res.body).not.toContain('route="/pool-stats"');
    // Belt-and-suspenders: no RED histogram sample may reference any non-/notifications route template.
    // (Regex over the emitted series — every recorded series' `route=` label must start with /notifications.)
    const redRouteLabels = [...res.body.matchAll(/notifications_http_request_duration_seconds\S*?route="([^"]*)"/g)];
    expect(redRouteLabels.length).toBeGreaterThan(0); // sanity: the histogram is actually populated
    for (const [, routeLabel] of redRouteLabels) {
      expect(routeLabel.startsWith('/notifications')).toBe(true);
    }
  });
});
