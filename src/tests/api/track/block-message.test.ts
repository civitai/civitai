import { describe, expect, it, vi, beforeEach } from 'vitest';
import client from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * POST /api/track/block-message — the App Blocks postMessage BRIDGE beacon, and
 * the only place `civitai_app_block_bridge_messages_total` is ever incremented.
 *
 * 🔴 THESE TESTS READ THE REAL prom-client COUNTER, before and after, not a mock
 * of one. A counter nobody has watched move is a claim about the code; a mocked
 * counter that "was called" is a claim about the mock. Every assertion below is a
 * DELTA on `client.register`, which is the same registry `/api/metrics` scrapes.
 *
 * 🔴 AND THE TWO LABEL BOUNDS ARE THE SECURITY PROPERTY UNDER TEST. This route is
 * public, unauthenticated and browser-reachable, so `type` and `app_block_id` come
 * straight off a client-supplied body — and prom-client retains every distinct
 * label set in the Node heap forever, across ~130 scraped pods. An unbounded label
 * here is an exit-139 OOM vector, not a tidiness problem. The `other` bucket is
 * the bound, and the negative + positive arms below are what make it real.
 *
 * ⚠️ SCOPE. `PublicEndpoint` is mocked to identity here, so the `['POST']` method
 * gate it owns is NOT covered by this file — read it as covering the handler body
 * (origin guard, parse, schema, label bounds, counter), not the whole route.
 */

const { devStore } = vi.hoisted(() => ({ devStore: { isDev: false } }));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic is what's under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

vi.mock('~/env/other', () => ({
  get isDev() {
    return devStore.isDev;
  },
  get isProd() {
    return !devStore.isDev;
  },
}));

// The real approved-app clamp is a TTL-cached DB read. Pin it so the
// `app_block_id` bound is deterministic: 'apb_test' is approved, everything
// else collapses to 'other'.
vi.mock('~/server/services/blocks/known-app-blocks.service', () => ({
  boundAppBlockIdLabel: vi.fn(async (id: string) => (id === 'apb_test' ? id : 'other')),
}));

function makeRes() {
  const res = {} as NextApiResponse & { _status?: number; _body?: unknown };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.end = vi.fn(() => res) as any;
  return res;
}

function makeReq(opts: {
  host?: string;
  origin?: string;
  referer?: string;
  body?: unknown;
  objectBody?: boolean;
}) {
  return {
    method: 'POST',
    headers: {
      host: opts.host ?? 'civitai.com',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.referer ? { referer: opts.referer } : {}),
    },
    body: opts.objectBody
      ? opts.body
      : typeof opts.body === 'string'
      ? opts.body
      : JSON.stringify(opts.body),
  } as unknown as NextApiRequest;
}

async function bridgeCounterValue(labels: {
  app_block_id: string;
  type: string;
  host: string;
  outcome: string;
}): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_bridge_messages_total');
  if (!metric) return 0;
  const data = await (
    metric as {
      get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    }
  ).get();
  const match = data.values.find((v) =>
    (Object.keys(labels) as Array<keyof typeof labels>).every((k) => v.labels[k] === labels[k])
  );
  return match?.value ?? 0;
}

async function post(body: unknown) {
  const handler = (await import('~/pages/api/track/block-message')).default;
  const req = makeReq({ origin: 'https://civitai.com', body });
  const res = makeRes();
  await handler(req as any, res);
  return res;
}

const event = (over: Partial<Record<string, unknown>> = {}) => ({
  appBlockId: 'apb_test',
  type: 'GET_VIEWER',
  host: 'IframeHost',
  outcome: 'handled',
  count: 1,
  ...over,
});

describe('POST /api/track/block-message — the bridge outcome counter', () => {
  beforeEach(() => {
    devStore.isDev = false;
  });

  it('THE NEGATIVE CONTROL: an error-class outcome moves the counter off zero', async () => {
    // 🔴 THE POINT OF THE CARD. `no_handler` is the outcome that was previously
    // indistinguishable from a healthy host. Read the PAIR — a zero alone is
    // indistinguishable from a probe wired to nothing.
    const labels = {
      app_block_id: 'apb_test',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'no_handler',
    };
    const before = await bridgeCounterValue(labels);
    const res = await post({ events: [event({ outcome: 'no_handler', count: 3 })] });
    const after = await bridgeCounterValue(labels);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(after - before).toBe(3);
    expect(after).toBeGreaterThan(0);
  });

  it('carries TWO distinct outcomes in one batch, one of them an error class', async () => {
    // Acceptance criterion 1 in one request: `handled` is the denominator and
    // `no_token` is an error class; a series with only one of the two cannot be
    // read as a rate.
    const handled = {
      app_block_id: 'apb_test',
      type: 'SUBMIT_WORKFLOW',
      host: 'PageBlockHost',
      outcome: 'handled',
    };
    const noToken = { ...handled, outcome: 'no_token' };
    const beforeHandled = await bridgeCounterValue(handled);
    const beforeNoToken = await bridgeCounterValue(noToken);

    await post({
      events: [
        event({ type: 'SUBMIT_WORKFLOW', host: 'PageBlockHost', outcome: 'handled', count: 17 }),
        event({ type: 'SUBMIT_WORKFLOW', host: 'PageBlockHost', outcome: 'no_token', count: 2 }),
      ],
    });

    expect((await bridgeCounterValue(handled)) - beforeHandled).toBe(17);
    expect((await bridgeCounterValue(noToken)) - beforeNoToken).toBe(2);
  });

  it('increments BY `count`, so client-side coalescing is lossless', async () => {
    const labels = {
      app_block_id: 'apb_test',
      type: 'POLL_WORKFLOW',
      host: 'PageBlockHost',
      outcome: 'handled',
    };
    const before = await bridgeCounterValue(labels);
    await post({ events: [event({ type: 'POLL_WORKFLOW', host: 'PageBlockHost', count: 120 })] });
    expect((await bridgeCounterValue(labels)) - before).toBe(120);
  });

  it('BOUNDS an unknown message type to `other`', async () => {
    const other = {
      app_block_id: 'apb_test',
      type: 'other',
      host: 'IframeHost',
      outcome: 'handled',
    };
    const before = await bridgeCounterValue(other);
    await post({ events: [event({ type: 'NOT_A_REAL_MESSAGE' })] });
    expect((await bridgeCounterValue(other)) - before).toBe(1);
    // …and the raw string never became a series of its own.
    expect(
      await bridgeCounterValue({
        app_block_id: 'apb_test',
        type: 'NOT_A_REAL_MESSAGE',
        host: 'IframeHost',
        outcome: 'handled',
      })
    ).toBe(0);
  });

  it('BOUNDS an unapproved appBlockId to `other`', async () => {
    const other = {
      app_block_id: 'other',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    };
    const before = await bridgeCounterValue(other);
    await post({ events: [event({ appBlockId: 'apb_not_approved' })] });
    expect((await bridgeCounterValue(other)) - before).toBe(1);
    expect(
      await bridgeCounterValue({
        app_block_id: 'apb_not_approved',
        type: 'GET_VIEWER',
        host: 'IframeHost',
        outcome: 'handled',
      })
    ).toBe(0);
  });

  it('THE POSITIVE CONTROL for the bound: a KNOWN type + KNOWN app survive verbatim', async () => {
    // A clamp that answered 'other' for everything would satisfy both negative
    // arms above. This is the arm that proves it can ever say yes.
    const labels = {
      app_block_id: 'apb_test',
      type: 'APP_STORAGE_GET',
      host: 'PageBlockHost',
      outcome: 'deduped',
    };
    const before = await bridgeCounterValue(labels);
    await post({
      events: [event({ type: 'APP_STORAGE_GET', host: 'PageBlockHost', outcome: 'deduped' })],
    });
    expect((await bridgeCounterValue(labels)) - before).toBe(1);
  });

  it('rejects an unknown host or outcome at the schema, before any label is minted', async () => {
    for (const bad of [{ host: 'SomeOtherHost' }, { outcome: 'exploded' }]) {
      const res = await post({ events: [event(bad)] });
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects a non-positive, fractional or oversized count', async () => {
    for (const count of [0, -1, 1.5, 10_001]) {
      const res = await post({ events: [event({ count })] });
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects an oversized batch and an empty one', async () => {
    const tooMany = { events: Array.from({ length: 201 }, () => event()) };
    expect((await post(tooMany)).status).toHaveBeenCalledWith(400);
    expect((await post({ events: [] })).status).toHaveBeenCalledWith(400);
  });

  it('refuses a beacon carrying NEITHER Origin NOR Referer', async () => {
    // 🔴 THE FAIL-CLOSED HALF OF THE GUARD, AND THE ONE A "be tolerant of clients
    // that strip Origin" refactor breaks. An allow-on-absent rule is satisfied by
    // sending nothing at all, so it would bound no one — on a public,
    // unauthenticated endpoint. Without this case that refactor lands green.
    const handler = (await import('~/pages/api/track/block-message')).default;
    const res = makeRes();
    await handler(makeReq({ body: { events: [event()] } }) as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res._body).toBe('invalid request');
  });

  it('refuses a SUFFIX-matching origin, not just an unrelated one', async () => {
    // A `.endsWith()` refactor of the host comparison passes the `evil.example`
    // case below and fails only this one.
    const handler = (await import('~/pages/api/track/block-message')).default;
    const res = makeRes();
    await handler(
      makeReq({ origin: 'https://evil.civitai.com', body: { events: [event()] } }) as any,
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts a Referer when Origin is absent (the documented fallback)', async () => {
    // POSITIVE CONTROL for the two refusals above: the guard can still say yes,
    // and on the exact path the helper's docstring says it supports. Without it,
    // a guard that rejected everything would satisfy every negative arm.
    const labels = {
      app_block_id: 'apb_test',
      type: 'SHARED_GET',
      host: 'IframeHost',
      outcome: 'handled',
    };
    const before = await bridgeCounterValue(labels);
    const handler = (await import('~/pages/api/track/block-message')).default;
    const res = makeRes();
    await handler(
      makeReq({
        referer: 'https://civitai.com/models/1',
        body: { events: [event({ type: 'SHARED_GET' })] },
      }) as any,
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((await bridgeCounterValue(labels)) - before).toBe(1);
  });

  it('refuses a cross-origin beacon', async () => {
    const handler = (await import('~/pages/api/track/block-message')).default;
    const res = makeRes();
    await handler(
      makeReq({ origin: 'https://evil.example', body: { events: [event()] } }) as any,
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res._body).toBe('invalid request');
  });

  it('accepts an OBJECT body (the real browser beacon path) as well as a string', async () => {
    // Next's parser hands an `application/json` body through as an object;
    // JSON.parse(<object>) would throw and 400 every real beacon.
    const labels = {
      app_block_id: 'apb_test',
      type: 'SHARED_LIST',
      host: 'PageBlockHost',
      outcome: 'rate_limited',
    };
    const before = await bridgeCounterValue(labels);
    const handler = (await import('~/pages/api/track/block-message')).default;
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        objectBody: true,
        body: {
          events: [event({ type: 'SHARED_LIST', host: 'PageBlockHost', outcome: 'rate_limited' })],
        },
      }) as any,
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((await bridgeCounterValue(labels)) - before).toBe(1);
  });

  it('short-circuits in dev without touching the counter', async () => {
    devStore.isDev = true;
    const labels = {
      app_block_id: 'apb_test',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    };
    const before = await bridgeCounterValue(labels);
    const res = await post({ events: [event()] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(await bridgeCounterValue(labels)).toBe(before);
  });
});
