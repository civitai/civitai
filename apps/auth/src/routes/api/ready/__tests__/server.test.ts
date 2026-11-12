import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clients: { cache: null, sys: null } as Record<
    string,
    { isOpen: boolean; isReady: boolean } | null
  >,
}));
vi.mock('$lib/server/redis', () => ({ peekRedisClients: () => h.clients }));

const call = async (mod: { GET: (e: never) => Response | Promise<Response> }) => {
  const res = await mod.GET({} as never);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.clients = { cache: { isOpen: true, isReady: true }, sys: null };
});
afterEach(() => vi.useRealTimers());

describe('GET /api/ready', () => {
  it('fails once a Redis client stays closed past the grace period, and recovers when it reopens', async () => {
    const ready = await import('../+server');
    expect(await call(ready)).toEqual({ status: 200, body: { status: 'ok' } });

    h.clients.cache = { isOpen: false, isReady: false };
    expect((await call(ready)).status).toBe(200); // a blip does not pull the pod
    vi.advanceTimersByTime(20_000);
    expect((await call(ready)).status).toBe(200);
    vi.advanceTimersByTime(11_000);
    expect(await call(ready)).toEqual({ status: 503, body: { status: 'unavailable' } });

    h.clients.cache = { isOpen: true, isReady: true };
    expect((await call(ready)).status).toBe(200);
  });

  it('leaves liveness (/api/health) passing while Redis is down', async () => {
    const ready = await import('../+server');
    const health = await import('../../health/+server');
    h.clients.cache = { isOpen: false, isReady: false };
    await call(ready);
    vi.advanceTimersByTime(31_000);
    expect((await call(ready)).status).toBe(503);
    expect(await call(health)).toEqual({ status: 200, body: { status: 'ok' } });
  });
});
