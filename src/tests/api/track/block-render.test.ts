import { describe, expect, it, vi, beforeEach } from 'vitest';
import client from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/track/block-render — the lightweight beacon that
 * replaces the track.blockRender tRPC mutation for the App Blocks hosts
 * (PageBlockHost / IframeHost). Mirrors src/tests/api/internal/pulse.test.ts.
 *
 * Verifies the security-critical contract:
 *  - same-origin guard (origin/referer host must equal request host),
 *  - body parse + blockRenderSchema validation (400 on bad input),
 *  - `isAnon` is stamped SERVER-SIDE from the resolved session (true when anon,
 *    false when logged in) and is NEVER taken from the client body,
 *  - a client-smuggled isAnon/userId in the body is IGNORED (schema strips it),
 *  - dev short-circuits to 200 with no insert.
 */

const { mockBlockRender, mockGetSession, devStore, sessionStore } = vi.hoisted(() => ({
  mockBlockRender: vi.fn(),
  mockGetSession: vi.fn(),
  devStore: { isDev: false },
  sessionStore: { session: null as { user?: { id: number } } | null },
}));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic (origin guard, parse, session ->
// isAnon, blockRender dispatch) is what's under test.
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

// The route resolves the session itself (to derive isAnon) and passes it to the
// Tracker. Drive it from sessionStore so each test controls anon vs logged-in.
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: (...args: unknown[]) => {
    mockGetSession(...args);
    return Promise.resolve(sessionStore.session);
  },
}));

// Tracker is the shared ClickHouse client; assert .blockRender() is called with
// the parsed ids PLUS the server-derived isAnon (same method the tRPC resolver
// used → identical `blockRenders` insert).
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    blockRender = mockBlockRender;
  },
}));

// Known-app clamp: control which appBlockIds count as "approved" so the render
// counter's `app_block_id` label bound is deterministic (real approved lookup is
// a TTL-cached DB query — mocked here). 'apb_test' is known; everything else → 'other'.
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
  // When true, pass `body` through as-is (an OBJECT) to simulate how Next's body
  // parser delivers an `application/json` request (the real browser beacon path).
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

const validInput = {
  appBlockId: 'apb_test',
  blockInstanceId: 'page_apb_test',
  slotId: 'app.page',
};

describe('POST /api/track/block-render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
    sessionStore.session = null;
  });

  it('stamps isAnon:true server-side for an anonymous viewer (no session)', async () => {
    sessionStore.session = null;
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('stamps isAnon:false server-side for a logged-in viewer (has session.user)', async () => {
    sessionStore.session = { user: { id: 42 } };
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: false });
  });

  it('IGNORES a client-smuggled isAnon/userId in the body (schema strips + server overrides)', async () => {
    // Anon session, but the client tries to spoof an authed render.
    sessionStore.session = null;
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, isAnon: false, userId: 9999 },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    const arg = mockBlockRender.mock.calls[0][0];
    // userId never reaches the Tracker (stripped by schema, stamped by actor).
    expect(arg).not.toHaveProperty('userId');
    // isAnon is the SERVER value (true = anon), NOT the client's spoofed false.
    expect(arg.isAnon).toBe(true);
    expect(arg).toEqual({ ...validInput, isAnon: true });
  });

  it('dispatches when Next pre-parsed the body to an OBJECT (application/json — the real browser path)', async () => {
    sessionStore.session = null;
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput, objectBody: true });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('accepts the referer host as the origin fallback', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: validInput,
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a cross-origin request (host mismatch) with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ host: 'civitai.com', origin: 'https://evil.example', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a request with no origin/referer with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ host: 'civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an unparseable body with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: '{not json' });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects schema-invalid input (missing required id) with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      // appBlockId missing → 400
      body: { blockInstanceId: 'page_apb_test', slotId: 'app.page' },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('short-circuits to 200 in dev without inserting', async () => {
    devStore.isDev = true;
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBlockRender).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// --- App Blocks runtime observability: the render-outcome prom counter --------
async function renderCounterValue(
  appBlockId: string,
  slotId: string,
  result: string
): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_renders_total');
  if (!metric) return 0;
  const data = await (
    metric as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
  ).get();
  const match = data.values.find(
    (v) => v.labels.app_block_id === appBlockId && v.labels.slot_id === slotId && v.labels.result === result
  );
  return match?.value ?? 0;
}

describe('POST /api/track/block-render — civitai_app_block_renders_total counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
    sessionStore.session = null;
  });

  it('increments result=ok (schema default) on a status-less beacon AND keeps status/errorClass out of the CH insert', async () => {
    const before = await renderCounterValue('apb_test', 'app.page', 'ok');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'app.page', 'ok')).toBe(before + 1);
    // status/errorClass never reach the ClickHouse insert (prom-only).
    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).not.toHaveProperty('status');
    expect(arg).not.toHaveProperty('errorClass');
    expect(arg).toEqual({ ...validInput, isAnon: true });
  });

  it('increments result=error when the beacon carries status:"error"', async () => {
    const before = await renderCounterValue('apb_test', 'app.page', 'error');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, status: 'error', errorClass: 'timeout' },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'app.page', 'error')).toBe(before + 1);
    // The error still writes the (identifier-only) CH row — status/errorClass stripped.
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: true });
  });

  it('clamps an UNKNOWN app_block_id to "other" (bounds the label) and preserves a known one', async () => {
    const beforeOther = await renderCounterValue('other', 'app.page', 'ok');
    const beforeKnown = await renderCounterValue('apb_test', 'app.page', 'ok');
    const handler = (await import('~/pages/api/track/block-render')).default;

    // Unknown/unapproved app id from a scripted client → bucketed to 'other'.
    const unknownReq = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, appBlockId: 'apb_attacker_garbage_9f3' },
    });
    await handler(unknownReq as any, makeRes());
    expect(await renderCounterValue('other', 'app.page', 'ok')).toBe(beforeOther + 1);

    // A known/approved app id is preserved (per-app attribution intact). The CH
    // insert still records the RAW client id — only the prom LABEL is clamped.
    const knownReq = makeReq({ origin: 'https://civitai.com', body: validInput });
    await handler(knownReq as any, makeRes());
    expect(await renderCounterValue('apb_test', 'app.page', 'ok')).toBe(beforeKnown + 1);
    expect(mockBlockRender).toHaveBeenLastCalledWith({ ...validInput, isAnon: true });
  });

  it('clamps an unknown slot_id to "other" to bound label cardinality', async () => {
    const before = await renderCounterValue('apb_test', 'other', 'ok');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, slotId: 'totally.unknown.slot' },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'other', 'ok')).toBe(before + 1);
  });
});
