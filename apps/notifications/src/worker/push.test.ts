import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral coverage for the push dispatcher: subscription targeting, the daily cap, and the
// push-service response table (410 delete / 429 keep / 413 truncate / 5xx failure streak). Same
// fake-pool + hoisted-state idiom as poll-loop.behavioral.test.ts.

const h = vi.hoisted(() => {
  const state: {
    subscriptionRows: any[];
    readQueries: { sql: string; params: any[] }[];
    writeQueries: { sql: string; params: any[] }[];
    redisCounters: Map<string, number>;
    redisAvailable: boolean;
    sendResults: (Error | null)[]; // per sendNotification call, in order; null = accept
    sends: { endpoint: string; body: string }[];
    renderResponse: { ok: boolean; results?: any[] };
    fetchCalls: { url: string; body: any }[];
  } = {
    subscriptionRows: [],
    readQueries: [],
    writeQueries: [],
    redisCounters: new Map(),
    redisAvailable: true,
    sendResults: [],
    sends: [],
    renderResponse: { ok: true, results: [{ title: 'T', body: 'B', url: '/x' }] },
    fetchCalls: [],
  };
  return { state };
});

vi.mock('../lib/server/clients/db', () => ({
  mainDbRead: () => ({
    cancellableQuery: async (sql: string, params: any[]) => {
      h.state.readQueries.push({ sql, params });
      return { result: async () => h.state.subscriptionRows };
    },
  }),
  mainDbWrite: () => ({
    cancellableQuery: async (sql: string, params: any[]) => {
      h.state.writeQueries.push({ sql, params });
      return { result: async () => [] };
    },
  }),
}));

vi.mock('../lib/server/clients/redis', () => ({
  getRedis: () =>
    h.state.redisAvailable
      ? {
          incrBy: async (key: string, by: number) => {
            const next = (h.state.redisCounters.get(key) ?? 0) + by;
            h.state.redisCounters.set(key, next);
            return next;
          },
          expire: async () => true,
        }
      : null,
}));

vi.mock('../lib/server/clients/axiom', () => ({
  logToAxiom: vi.fn(async () => {}),
  logAxiomError: vi.fn(() => {}),
}));

vi.mock('../env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env')>()),
  pushEnabled: true,
  pushDailyCap: 3,
  vapidPublicKey: 'test-public',
  vapidPrivateKey: 'test-private',
  vapidSubject: 'mailto:test@test',
  mainAppUrl: 'http://main.test',
  mainAppWebhookToken: 'tok',
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, body: string) => {
      h.state.sends.push({ endpoint: sub.endpoint, body });
      const result = h.state.sendResults.shift();
      if (result) throw result;
    }),
  },
}));

import { dispatchPush } from './push';

function statusError(statusCode: number): Error {
  const err = new Error(`status ${statusCode}`);
  (err as any).statusCode = statusCode;
  return err;
}

function sub(id: number, userId: number) {
  return { id, userId, endpoint: `https://push.test/${id}`, p256dh: 'k', auth: 'a' };
}

const realFetch = global.fetch;

beforeEach(() => {
  h.state.subscriptionRows = [];
  h.state.readQueries = [];
  h.state.writeQueries = [];
  h.state.redisCounters = new Map();
  h.state.redisAvailable = true;
  h.state.sendResults = [];
  h.state.sends = [];
  h.state.renderResponse = { ok: true, results: [{ title: 'T', body: 'B', url: '/x' }] };
  h.state.fetchCalls = [];
  global.fetch = vi.fn(async (url: any, init: any) => {
    h.state.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: h.state.renderResponse.ok,
      status: h.state.renderResponse.ok ? 200 : 500,
      json: async () => ({ results: h.state.renderResponse.results ?? [] }),
    };
  }) as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('dispatchPush', () => {
  it('sends the rendered payload to every subscription of every opted-in user', async () => {
    h.state.subscriptionRows = [sub(1, 10), sub(2, 10), sub(3, 20)];
    await dispatchPush('new-mention', { v: 1 }, [10, 20, 30]);

    expect(h.state.sends.map((s) => s.endpoint)).toEqual([
      'https://push.test/1',
      'https://push.test/2',
      'https://push.test/3',
    ]);
    expect(JSON.parse(h.state.sends[0]!.body)).toEqual({ title: 'T', body: 'B', url: '/x' });
    // The targeting query got the affected users and the type — the opt-in filter is SQL-side.
    expect(h.state.readQueries[0]!.params).toEqual([[10, 20, 30], 'new-mention']);
    // Renders exactly once per notification, not per subscription.
    expect(h.state.fetchCalls).toHaveLength(1);
    // Every accepted send stamps lastSuccessAt.
    expect(h.state.writeQueries.filter((q) => q.sql.includes('lastSuccessAt'))).toHaveLength(3);
  });

  it('sends nothing when no affected user has a push setting row', async () => {
    h.state.subscriptionRows = [];
    await dispatchPush('new-mention', {}, [10]);
    expect(h.state.sends).toHaveLength(0);
    // No render round trip either — targeting is checked first.
    expect(h.state.fetchCalls).toHaveLength(0);
  });

  it('sends nothing when the render endpoint has no message for the type', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.renderResponse = { ok: true, results: [null] };
    await dispatchPush('unrenderable-type', {}, [10]);
    expect(h.state.sends).toHaveLength(0);
  });

  it('deletes the subscription on 410 Gone without counting it as a failure', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.sendResults = [statusError(410)];
    await dispatchPush('new-mention', {}, [10]);

    const deletes = h.state.writeQueries.filter((q) => q.sql.trim().startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toEqual([1]);
    expect(h.state.writeQueries.filter((q) => q.sql.includes('failureCount'))).toHaveLength(0);
  });

  it('deletes the subscription on 404 as well', async () => {
    h.state.subscriptionRows = [sub(7, 10)];
    h.state.sendResults = [statusError(404)];
    await dispatchPush('new-mention', {}, [10]);
    const deletes = h.state.writeQueries.filter((q) => q.sql.trim().startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toEqual([7]);
  });

  it('keeps the subscription untouched on 429', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.sendResults = [statusError(429)];
    await dispatchPush('new-mention', {}, [10]);
    expect(h.state.writeQueries).toHaveLength(0);
  });

  it('retries a 413 with a truncated body', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.renderResponse = {
      ok: true,
      results: [{ title: 'T', body: 'x'.repeat(5000), url: '/x' }],
    };
    h.state.sendResults = [statusError(413), null];
    await dispatchPush('new-mention', {}, [10]);

    expect(h.state.sends).toHaveLength(2);
    const retryPayload = JSON.parse(h.state.sends[1]!.body);
    expect(retryPayload.body.length).toBeLessThanOrEqual(500);
    expect(h.state.writeQueries.filter((q) => q.sql.includes('lastSuccessAt'))).toHaveLength(1);
  });

  it('records a failure streak on 5xx (delete-at-10 lives in the SQL)', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.sendResults = [statusError(500)];
    await dispatchPush('new-mention', {}, [10]);

    const failureWrites = h.state.writeQueries.filter((q) => q.sql.includes('"failureCount" + 1'));
    expect(failureWrites).toHaveLength(1);
    expect(failureWrites[0]!.params).toEqual([1, 10]);
  });

  it('caps a user at pushDailyCap, then sends exactly one summary push', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    for (let i = 0; i < 6; i++) {
      await dispatchPush('new-mention', { n: i }, [10]);
    }
    // Cap is 3: three real pushes, one summary, then silence.
    expect(h.state.sends).toHaveLength(4);
    const summary = JSON.parse(h.state.sends[3]!.body);
    expect(summary.body).toContain('more notifications');
    // Renders keep happening (other users could be under cap) but sends stop.
    expect(h.state.fetchCalls).toHaveLength(6);
  });

  it('fails open when redis is down: pushes still send', async () => {
    h.state.redisAvailable = false;
    h.state.subscriptionRows = [sub(1, 10)];
    for (let i = 0; i < 5; i++) {
      await dispatchPush('new-mention', { n: i }, [10]);
    }
    expect(h.state.sends).toHaveLength(5);
  });

  it('never throws — a render endpoint outage is swallowed', async () => {
    h.state.subscriptionRows = [sub(1, 10)];
    h.state.renderResponse = { ok: false };
    await expect(dispatchPush('new-mention', {}, [10])).resolves.toBeUndefined();
    expect(h.state.sends).toHaveLength(0);
  });
});
