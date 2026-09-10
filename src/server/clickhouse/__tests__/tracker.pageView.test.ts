import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `Tracker.pageView()` — the WIRE payload, exercised through the real Tracker.
 *
 * 🔴 WHY THIS FILE EXISTS, AND WHY THE UNIT TESTS NEXT DOOR ARE NOT ENOUGH.
 * `tracker-pageview-clamp.test.ts` calls `clampToColumn` with the TEST FILE'S OWN copies
 * of the bounds, and its wiring assertions match the SOURCE TEXT `clampToColumn(windowWidth,
 * INT16_MAX)` — the identifier, not its value. So no assertion over there is a function of
 * the two constants in `tracker.ts` that actually decide what reaches ClickHouse.
 *
 * Measured: changing `INT16_MAX` from 32_767 to 65_535 in tracker.ts left that suite
 * entirely green — 87 passed, identical to unmutated — while every window dimension in
 * (32767, 65535] would then go straight at an `Int16` column and destroy its row. That is
 * the exact silent loss this change exists to close, reintroduced behind a green gate.
 *
 * This file closes that hole by asserting the VALUE that is POSTed. It reads the bounds
 * from nowhere: the expectations below are literal numbers, so a wrong constant in
 * tracker.ts changes the wire payload and fails here.
 */

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const [, init] = call as [string, { body: string }];
  return JSON.parse(init.body);
}

/** The ClickHouse column ceilings, written as literals on purpose — see the header. */
const UINT32_CEILING = 4294967295;
const INT16_CEILING = 32767;

const basePageView = {
  pageId: '/models',
  path: '/models',
  host: 'civitai.com',
  ads: false,
  country: 'US',
  duration: 5_000,
  windowWidth: 1_920,
  windowHeight: 1_040,
};

async function emit(overrides: Partial<typeof basePageView>, fetchMock: ReturnType<typeof vi.fn>) {
  const tracker = new Tracker(undefined, undefined, { user: { id: 555 } } as never);
  await tracker.pageView({ ...basePageView, ...overrides });
  // send() is fire-and-forget internally; allow the microtask queue to flush.
  await new Promise((r) => setImmediate(r));
  return lastFetchBody(fetchMock);
}

describe('Tracker.pageView wire payload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs to the pageViews table', async () => {
    await emit({}, fetchMock);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://tracker.test/track/pageViews');
  });

  it('passes ordinary values through untouched', async () => {
    // The clamp must be the identity on everything that already landed. If this fails,
    // the change is altering healthy rows, which is worse than the bug it fixes.
    const body = await emit({}, fetchMock);
    expect(body).toMatchObject({ duration: 5_000, windowWidth: 1_920, windowHeight: 1_040 });
  });

  it('emits the exact UInt32 ceiling for an over-range duration', async () => {
    // 4742447225 is a real rejected production value.
    const body = await emit({ duration: 4_742_447_225 }, fetchMock);
    expect(body.duration).toBe(UINT32_CEILING);
  });

  it('emits the exact Int16 ceiling for over-range window dimensions', async () => {
    // 🔴 THIS is the assertion the unit tests could not make. 183800/211900 are real
    // rejected production values; both exceed Int16 and both must arrive clamped. A
    // wrong INT16_MAX in tracker.ts emits 65535 (or the raw value) and fails here.
    const body = await emit({ windowWidth: 183_800, windowHeight: 211_900 }, fetchMock);
    expect(body.windowWidth).toBe(INT16_CEILING);
    expect(body.windowHeight).toBe(INT16_CEILING);
  });

  it('emits a value just past Int16 as the ceiling, not as itself', async () => {
    // The narrowest case, and the one a too-wide constant lets through: 32768 is inside
    // a UInt16/Int32 bound but outside Int16.
    const body = await emit({ windowWidth: 32_768, windowHeight: 40_000 }, fetchMock);
    expect(body.windowWidth).toBe(INT16_CEILING);
    expect(body.windowHeight).toBe(INT16_CEILING);
  });

  it('emits a value just past UInt32 as the ceiling, not as itself', async () => {
    const body = await emit({ duration: 4_294_967_296 }, fetchMock);
    expect(body.duration).toBe(UINT32_CEILING);
  });

  it('emits the exact ceilings unchanged when a value is already at the bound', async () => {
    // The safe-direction off-by-one: clamping the boundary itself would corrupt
    // legitimate maximum values on every row.
    const body = await emit(
      { duration: UINT32_CEILING, windowWidth: INT16_CEILING, windowHeight: INT16_CEILING },
      fetchMock
    );
    expect(body.duration).toBe(UINT32_CEILING);
    expect(body.windowWidth).toBe(INT16_CEILING);
    expect(body.windowHeight).toBe(INT16_CEILING);
  });

  it('emits 0 for negative and non-finite input rather than a rejectable value', async () => {
    const body = await emit(
      { duration: Number.NaN, windowWidth: -1, windowHeight: Number.POSITIVE_INFINITY },
      fetchMock
    );
    expect(body.duration).toBe(0);
    expect(body.windowWidth).toBe(0);
    expect(body.windowHeight).toBe(0);
  });

  it('carries every other field through, so the clamp drops nothing', async () => {
    // The destructure-out-of-spread could silently drop a field if `...rest` were
    // mis-built. This pins that the non-clamped fields still arrive.
    const body = await emit({}, fetchMock);
    expect(body).toMatchObject({
      pageId: '/models',
      path: '/models',
      host: 'civitai.com',
      ads: false,
      country: 'US',
      userId: 555, // stamped server-side from the session, not the client
    });
  });
});
