import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /health end to end: real cache ops against a fake redis feed the real tracker, and the real route
// reports it. The tracker is a module singleton, so each case re-imports the graph for a fresh one.

const { fakeRedis } = vi.hoisted(() => ({
  fakeRedis: { exists: vi.fn(), hIncrBy: vi.fn() },
}));
vi.mock('../lib/server/clients/redis', () => ({ getRedis: () => fakeRedis }));

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

async function load() {
  vi.resetModules();
  const { buildServer } = await import('../app');
  const { notificationCache } = await import('../lib/server/cache');
  const { health } = await import('../lib/server/health');
  const app = await buildServer();
  await app.ready();
  return { app, notificationCache, health };
}

let ctx: Awaited<ReturnType<typeof load>>;

function at(offsetMs: number) {
  vi.setSystemTime(T0 + offsetMs);
}

async function bump() {
  await ctx.notificationCache.incrementUser(1, 'Comment').catch(() => null);
}

async function getHealth() {
  const res = await ctx.app.inject({ method: 'GET', url: '/health' });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  fakeRedis.exists.mockReset();
  fakeRedis.hIncrBy.mockReset();
  ctx = await load();
});

afterEach(async () => {
  await ctx.app.close();
  vi.useRealTimers();
});

const down = () => fakeRedis.exists.mockRejectedValue(new Error('connect EHOSTUNREACH'));
const up = () => fakeRedis.exists.mockResolvedValue(1);

describe('GET /health on a worker pod', () => {
  beforeEach(() => ctx.health.markWorkerStarted());

  it('fails once every redis command has failed for over a minute', async () => {
    down();
    for (const t of [0, 20_000, 40_000, 61_000]) {
      at(t);
      ctx.health.markWorkerProgress();
      await bump();
    }

    const { status, body } = await getHealth();
    expect(status).toBe(503);
    expect(body.reasons).toEqual(['redis: every command failed for 61s']);
  });

  it('stays healthy through a blip: a success inside the window resets the streak', async () => {
    down();
    for (const t of [0, 20_000, 40_000]) {
      at(t);
      await bump();
    }
    at(45_000);
    up();
    await bump();
    down();
    for (const t of [50_000, 80_000, 104_000]) {
      at(t);
      ctx.health.markWorkerProgress();
      await bump();
    }

    expect(await getHealth()).toEqual({
      status: 200,
      body: { status: 'ok', service: 'notifications' },
    });
  });

  it('fails when the poll loop has made no progress for ten minutes, and recovers when it does', async () => {
    at(10 * 60_000 - 1);
    expect((await getHealth()).status).toBe(200);

    at(10 * 60_000);
    const stalled = await getHealth();
    expect(stalled.status).toBe(503);
    expect(stalled.body.reasons).toEqual(['worker: no progress for 600s']);

    ctx.health.markWorkerProgress();
    expect((await getHealth()).status).toBe(200);
  });

  it('fails when one lane stalls even while another keeps making progress', async () => {
    ctx.health.markWorkerStarted('bulk');
    at(10 * 60_000);
    ctx.health.markWorkerProgress('bulk');

    const stalled = await getHealth();
    expect(stalled.status).toBe(503);
    expect(stalled.body.reasons).toEqual(['worker: no progress for 600s']);
  });
});

describe('GET /health on an API-only pod (worker not started)', () => {
  it('stays 200 through a sustained redis outage and no worker progress', async () => {
    down();
    for (const t of [0, 30_000, 61_000, 20 * 60_000]) {
      at(t);
      await bump();
    }
    expect((await getHealth()).status).toBe(200);
  });
});
