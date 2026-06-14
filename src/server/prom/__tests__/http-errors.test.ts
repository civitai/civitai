import { EventEmitter } from 'node:events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it } from 'vitest';
import { httpErrorCounter, instrumentApiResponse } from '~/server/prom/http-errors';

// Safety contract for instrumentApiResponse — the single helper that PR #2539
// attaches to the (payment) webhook handlers. The whole "is it safe on the
// payment path?" question reduces to two properties, asserted here at runtime:
//   1. PASSIVE: it must never mutate the response. If it did, it could change
//      the status the provider receives (Stripe retries non-2xx → duplicate /
//      missed events) or add latency to the ack. It must only read statusCode.
//   2. 5xx-ONLY, ONCE: it increments the error counter only on status >= 500,
//      exactly once per response, and a metric failure can never escape.

// A response double that behaves like the Node ServerResponse `finish` emitter
// the helper relies on, and trips `mutations` if the helper touches the response
// in ANY way (these are the methods that could alter what the provider receives).
function makeRes(statusCode: number) {
  const ee = new EventEmitter();
  const mutations: string[] = [];
  const trap =
    (name: string) =>
    (..._args: unknown[]) => {
      mutations.push(name);
    };
  const res = Object.assign(ee, {
    statusCode,
    write: trap('write'),
    end: trap('end'),
    json: trap('json'),
    send: trap('send'),
    status: trap('status'),
    setHeader: trap('setHeader'),
    writeHead: trap('writeHead'),
    removeHeader: trap('removeHeader'),
    flushHeaders: trap('flushHeaders'),
  });
  return { res: res as unknown as NextApiResponse, mutations, emitFinish: () => ee.emit('finish') };
}

// Mirrors a real webhook request shape (static path, no URL token).
const webhookReq = {
  method: 'POST',
  url: '/api/webhooks/stripe',
  query: {},
} as unknown as NextApiRequest;
const ROUTE = 'POST /api/webhooks/stripe';

async function countFor(route: string, status: string): Promise<number> {
  const metric = await httpErrorCounter.get();
  const values = metric.values as { value: number; labels: Record<string, string | number> }[];
  const hit = values.find(
    (v) => v.labels.route === route && v.labels.status === status && v.labels.kind === 'api'
  );
  return hit?.value ?? 0;
}

describe('instrumentApiResponse', () => {
  it('never mutates the response and does not count on a 2xx ack', async () => {
    const before = await countFor(ROUTE, '200');
    const { res, mutations, emitFinish } = makeRes(200);
    instrumentApiResponse(webhookReq, res);
    emitFinish();
    expect(mutations).toEqual([]); // passive — the provider's ack is untouched
    expect(res.statusCode).toBe(200); // status unchanged by the listener
    expect(await countFor(ROUTE, '200')).toBe(before); // 2xx is never counted
  });

  it('never mutates the response and does not count on a 4xx (bad signature)', async () => {
    const before = await countFor(ROUTE, '400');
    const { res, mutations, emitFinish } = makeRes(400);
    instrumentApiResponse(webhookReq, res);
    emitFinish();
    expect(mutations).toEqual([]);
    expect(res.statusCode).toBe(400);
    expect(await countFor(ROUTE, '400')).toBe(before); // 4xx (e.g. sig fail) not counted
  });

  it('counts a 5xx exactly once without mutating the response', async () => {
    const before = await countFor(ROUTE, '500');
    const { res, mutations, emitFinish } = makeRes(500);
    instrumentApiResponse(webhookReq, res);
    emitFinish();
    expect(mutations).toEqual([]); // still passive on the error path
    expect(res.statusCode).toBe(500);
    expect(await countFor(ROUTE, '500')).toBe(before + 1);
  });

  it('is a one-shot listener — a re-emitted finish cannot double-count or leak', async () => {
    const before = await countFor(ROUTE, '500');
    const { res, emitFinish } = makeRes(500);
    instrumentApiResponse(webhookReq, res);
    emitFinish();
    emitFinish(); // `once` → second emit is a no-op
    expect(await countFor(ROUTE, '500')).toBe(before + 1);
    expect((res as unknown as EventEmitter).listenerCount('finish')).toBe(0); // removed → no leak
  });

  it('never throws out of the listener even on a malformed request', async () => {
    const badReq = { method: 'POST', url: '://%%bad', query: {} } as unknown as NextApiRequest;
    const { res, emitFinish } = makeRes(500);
    instrumentApiResponse(badReq, res);
    expect(() => emitFinish()).not.toThrow(); // telemetry failure can't break the response
  });

  it('no-ops (never throws) on a non-EventEmitter res double without .once', () => {
    // Handler unit tests often pass a partial res mock (status/json/setHeader)
    // with no .once. The helper must not throw — else it breaks the handler in
    // every such test (regression caught in oauth/token-endpoint.test.ts).
    const fakeRes = { statusCode: 200, status: () => fakeRes, json: () => fakeRes };
    const req = { method: 'POST', url: '/api/auth/oauth/token', query: {} } as unknown as NextApiRequest;
    expect(() => instrumentApiResponse(req, fakeRes as unknown as NextApiResponse)).not.toThrow();
    // and a null/undefined res must not throw either (total "never break" contract)
    expect(() =>
      instrumentApiResponse(req, undefined as unknown as NextApiResponse)
    ).not.toThrow();
  });
});
