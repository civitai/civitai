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
  result: string,
  errorClass?: string
): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_renders_total');
  if (!metric) return 0;
  const data = await (
    metric as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
  ).get();
  const match = data.values.find(
    (v) =>
      v.labels.app_block_id === appBlockId &&
      v.labels.slot_id === slotId &&
      v.labels.result === result &&
      (errorClass === undefined || v.labels.error_class === errorClass)
  );
  return match?.value ?? 0;
}

describe('POST /api/track/block-render — civitai_app_block_renders_total counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
    sessionStore.session = null;
  });

  it('increments result=ok with error_class=none on a status-less beacon AND keeps status/errorClass out of the CH insert', async () => {
    const before = await renderCounterValue('apb_test', 'app.page', 'ok', 'none');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'app.page', 'ok', 'none')).toBe(before + 1);
    // status/errorClass never reach the ClickHouse insert (prom-only).
    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).not.toHaveProperty('status');
    expect(arg).not.toHaveProperty('errorClass');
    expect(arg).toEqual({ ...validInput, isAnon: true });
  });

  it('increments result=error with the sent error_class label when the beacon carries status:"error"', async () => {
    const before = await renderCounterValue('apb_test', 'app.page', 'error', 'timeout');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, status: 'error', errorClass: 'timeout' },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'app.page', 'error', 'timeout')).toBe(before + 1);
    // The error still writes the (identifier-only) CH row — status/errorClass stripped.
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: true });
  });

  it('preserves each KNOWN error_class on the label', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    for (const ec of [
      'fatal',
      'no_token',
      'error',
      'error_boundary',
      // MID-SESSION credential loss (PageBlockHost). Distinct from every launch
      // failure above because it describes a page load that ALREADY SUCCEEDED and
      // was later torn down (delist/suspend/revoke). It has to survive the
      // allowlist as itself: bucketed to 'other' it would be indistinguishable
      // from client garbage, which is what made the 2026-07-31 production
      // revocation unattributable.
      'token_lost_midsession',
    ] as const) {
      const before = await renderCounterValue('apb_test', 'app.page', 'error', ec);
      await handler(
        makeReq({
          origin: 'https://civitai.com',
          body: { ...validInput, status: 'error', errorClass: ec },
        }) as any,
        makeRes()
      );
      expect(await renderCounterValue('apb_test', 'app.page', 'error', ec)).toBe(before + 1);
    }
  });

  /**
   * 🔴 THE IMPRESSION TABLE MUST STAY 1 ROW PER MOUNT.
   *
   * `blockRenders` counts IMPRESSIONS and its rows carry NO status, so two rows
   * for one mount are byte-identical and cannot be de-duplicated afterwards.
   * Since a host can now emit a SECOND beacon for a mount whose outcome changed
   * (rendered fine, then lost its credential), an unguarded insert would inflate
   * every CH-derived impression figure for exactly the revoked sessions.
   *
   * The gate is the `secondary` FLAG, not `status === 'error'` — a LAUNCH failure
   * is a mount's only beacon and must still be recorded. These two cases pin both
   * halves of that rule.
   */
  it('🔴 a SECONDARY beacon counts in prom but writes NO ClickHouse row', async () => {
    const before = await renderCounterValue(
      'apb_test',
      'app.page',
      'error',
      'token_lost_midsession'
    );
    const handler = (await import('~/pages/api/track/block-render')).default;
    const res = makeRes();

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: {
          ...validInput,
          status: 'error',
          errorClass: 'token_lost_midsession',
          secondary: true,
        },
      }) as any,
      res
    );

    // The observability signal still fires — this is what the alert reads.
    expect(
      await renderCounterValue('apb_test', 'app.page', 'error', 'token_lost_midsession')
    ).toBe(before + 1);
    // …but the impression table is untouched.
    expect(mockBlockRender).not.toHaveBeenCalled();
    // And the request still succeeds (fire-and-forget beacon).
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('🔴 a LAUNCH failure is NOT secondary — it still writes its ClickHouse row', async () => {
    // The discriminator must not be `status === 'error'`. A mount that never
    // rendered emits exactly one beacon, and that beacon represents a real
    // attempted render that analytics must keep counting.
    const handler = (await import('~/pages/api/track/block-render')).default;

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { ...validInput, status: 'error', errorClass: 'no_token' },
      }) as any,
      makeRes()
    );

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).toEqual({ ...validInput, isAnon: true });
    // `secondary` is stripped like status/errorClass — never a CH column.
    expect(arg).not.toHaveProperty('secondary');
  });

  it('clamps an UNKNOWN error_class to "other" (bounds the label) and still strips it from the CH insert', async () => {
    const before = await renderCounterValue('apb_test', 'app.page', 'error', 'other');
    const handler = (await import('~/pages/api/track/block-render')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { ...validInput, status: 'error', errorClass: 'attacker_garbage_zzz' },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(await renderCounterValue('apb_test', 'app.page', 'error', 'other')).toBe(before + 1);
    // CH insert stays byte-identical: neither status nor errorClass is forwarded.
    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).not.toHaveProperty('status');
    expect(arg).not.toHaveProperty('errorClass');
    expect(arg).toEqual({ ...validInput, isAnon: true });
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

// --- App Blocks LAUNCH LATENCY: the two launch histograms ---------------------
type HistPoint = { metricName?: string; labels: Record<string, string>; value: number };

async function histCount(name: string, labels: Record<string, string>): Promise<number> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return 0;
  const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
  const point = data.values.find(
    (v) =>
      v.metricName === `${name}_count` &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return point?.value ?? 0;
}

const LAUNCH_TOTAL = 'civitai_app_block_launch_total_seconds';
const LAUNCH_PHASE = 'civitai_app_block_launch_phase_seconds';
const timings = { totalMs: 1_100, tokenMintMs: 180, initWaitMs: 700 };

describe('POST /api/track/block-render — launch-latency histograms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
    sessionStore.session = null;
  });

  it('observes the launch on an `ok` beacon that carries timings', async () => {
    const beforeTotal = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });
    const beforeInit = await histCount(LAUNCH_PHASE, { phase: 'init_wait' });
    const handler = (await import('~/pages/api/track/block-render')).default;

    await handler(
      makeReq({ origin: 'https://civitai.com', body: { ...validInput, timings } }) as any,
      makeRes()
    );

    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(beforeTotal + 1);
    expect(await histCount(LAUNCH_PHASE, { phase: 'init_wait' })).toBe(beforeInit + 1);
  });

  /**
   * 🔴 IMPRESSION ACCOUNTING IS UNCHANGED — the whole reason the timings ride the
   * EXISTING beacon instead of a second one. One beacon in: exactly one
   * `renders_total` increment, exactly one ClickHouse row, and now also exactly
   * one launch observation. A `2` on any of these means the beacon contract
   * broke.
   */
  it('🔴 one beacon still yields exactly ONE renders_total increment and ONE ClickHouse row', async () => {
    const beforeRender = await renderCounterValue('apb_test', 'app.page', 'ok', 'none');
    const beforeLaunch = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });
    const handler = (await import('~/pages/api/track/block-render')).default;

    await handler(
      makeReq({ origin: 'https://civitai.com', body: { ...validInput, timings } }) as any,
      makeRes()
    );

    expect(await renderCounterValue('apb_test', 'app.page', 'ok', 'none')).toBe(beforeRender + 1);
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(beforeLaunch + 1);
    expect(mockBlockRender).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 The CH payload must stay byte-identical. This is the REST half of the
   * two-write-path pair (the tRPC half lives in
   * src/server/routers/__tests__/track.router.blockRender.test.ts) — both writers
   * go through the shared `blockRenderTrackerPayload` allowlist.
   */
  it('🔴 never forwards `timings` to the ClickHouse insert', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;

    await handler(
      makeReq({ origin: 'https://civitai.com', body: { ...validInput, timings } }) as any,
      makeRes()
    );

    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).not.toHaveProperty('timings');
    expect(arg).toEqual({ ...validInput, isAnon: true });
  });

  /**
   * 🔴 A LAUNCH FAILURE MUST NOT BE OBSERVED AS A LAUNCH. It never saw
   * BLOCK_READY, so its "total" is meaningless — and a fast failure would be
   * recorded as a FAST LAUNCH, biasing the distribution in exactly the direction
   * that reads as healthy. Includes the positive control, because a zero delta
   * here is otherwise indistinguishable from a metric wired to nothing.
   */
  it('🔴 does NOT observe a launch for an `error` beacon, even if timings are attached', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const before = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { ...validInput, status: 'error', errorClass: 'timeout', timings },
      }) as any,
      makeRes()
    );
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(before);

    // POSITIVE CONTROL: the identical timings on an `ok` beacon DO move it by 1.
    await handler(
      makeReq({ origin: 'https://civitai.com', body: { ...validInput, timings } }) as any,
      makeRes()
    );
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(before + 1);
  });

  it('🔴 does NOT observe a launch for a `secondary` teardown beacon', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const before = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: {
          ...validInput,
          status: 'error',
          errorClass: 'token_lost_midsession',
          secondary: true,
          timings,
        },
      }) as any,
      makeRes()
    );

    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(before);
  });

  /**
   * 🔴 THE `!secondary` HALF OF THE GATE, REACHED ON ITS OWN.
   *
   * The test above uses `status:'error'`, so `status === 'ok'` alone already
   * rejects it — mutation-checked: deleting `&& !secondary` leaves that test
   * GREEN, i.e. it proves nothing about this half. Today's only secondary beacon
   * is an error, but the schema permits `secondary` with `status:'ok'` (a
   * bearer/API-key caller, or a future follow-up that reports a non-error state
   * change), and such a beacon is a TEARDOWN report minutes after the launch —
   * its `total` would be pure noise. This case reaches the second half of the
   * gate with an input the first half cannot reject.
   */
  it('🔴 does NOT observe a launch for a secondary beacon that is also `ok`', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const before = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { ...validInput, status: 'ok', secondary: true, timings },
      }) as any,
      makeRes()
    );
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(before);

    // POSITIVE CONTROL: identical body minus `secondary` DOES move it by 1, so
    // the zero above is the gate and not a dead metric.
    await handler(
      makeReq({ origin: 'https://civitai.com', body: { ...validInput, status: 'ok', timings } }) as any,
      makeRes()
    );
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(before + 1);
  });

  it('clamps an unknown app_block_id to "other" on the launch histogram too', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const before = await histCount(LAUNCH_TOTAL, { app_block_id: 'other' });

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { ...validInput, appBlockId: 'apb_attacker_garbage_zz1', timings },
      }) as any,
      makeRes()
    );

    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'other' })).toBe(before + 1);
  });

  /**
   * 🔴 MALFORMED TIMINGS MUST NOT COST THE IMPRESSION. `timings` carries
   * `.catch(undefined)`, so a client bug (a NaN, a renamed field, a string)
   * degrades to "no timings" instead of failing the whole
   * `blockRenderSchema.safeParse` → 400 → a LOST impression. An observability
   * add-on must be strictly subordinate to the analytics event it rides on.
   */
  it('🔴 a malformed `timings` still records the impression — it does not 400 the beacon', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const beforeRender = await renderCounterValue('apb_test', 'app.page', 'ok', 'none');
    const beforeLaunch = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });
    const res = makeRes();

    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { ...validInput, timings: { totalMs: 'not-a-number' } },
      }) as any,
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(mockBlockRender.mock.calls[0][0]).toEqual({ ...validInput, isAnon: true });
    expect(await renderCounterValue('apb_test', 'app.page', 'ok', 'none')).toBe(beforeRender + 1);
    // …but nothing junk reaches the histogram.
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(beforeLaunch);
  });

  /**
   * The BACK-COMPAT case, and the reason `timings` is optional rather than
   * required: IframeHost (the in-page slot host) and any client that has not
   * been rebuilt send no `timings`. Those beacons must behave exactly as they
   * did before — impression recorded, counter incremented, no launch sample and
   * no error.
   */
  it('records the impression normally when the beacon carries NO timings at all', async () => {
    const handler = (await import('~/pages/api/track/block-render')).default;
    const beforeRender = await renderCounterValue('apb_test', 'app.page', 'ok', 'none');
    const beforeLaunch = await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' });
    const res = makeRes();

    await handler(makeReq({ origin: 'https://civitai.com', body: validInput }) as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput, isAnon: true });
    expect(await renderCounterValue('apb_test', 'app.page', 'ok', 'none')).toBe(beforeRender + 1);
    expect(await histCount(LAUNCH_TOTAL, { app_block_id: 'apb_test' })).toBe(beforeLaunch);
  });
});
