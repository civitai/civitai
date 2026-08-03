import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the customComfy post-paid SETTLE-TO-ACTUAL service (plan
 * §5.3). This is the security-critical accounting that keeps the per-user daily
 * + per-app aggregate caps honest against a post-paid job whose real cost is only
 * known at terminal: reserve the CEILING at submit, refund `ceiling - actual` on
 * BOTH keys exactly once at the first terminal observation.
 *
 * The refund path is exercised against a fake sysRedis (get/set/del/decrBy) so we
 * assert the exact GET+DEL idempotency claim and the exact decrBy deltas.
 */

const {
  mockSysRedis,
  mockRefundAppSpend,
  mockRefundDevSessionBuzz,
  mockObserveActualBuzz,
  mockObserveWallclock,
} = vi.hoisted(() => ({
  mockSysRedis: {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 1),
    decrBy: vi.fn(async () => 0),
  },
  mockRefundAppSpend: vi.fn(async () => undefined),
  // F4 — the dev-session refund leg dynamic-imports refundDevSessionBuzz. Mock the
  // (heavy, k8s-client-pulling) dev-tunnel module at its boundary so the settle's
  // third refund is assertable without loading the real service.
  mockRefundDevSessionBuzz: vi.fn(async () => undefined),
  // Per-engine observability emit — mocked at the metrics-module boundary so the
  // settle's engine/recipe label + observed value are assertable without the real
  // prom-client registry.
  mockObserveActualBuzz: vi.fn(() => undefined),
  mockObserveWallclock: vi.fn(() => undefined),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { CUSTOM_COMFY_SETTLE: 'system:blocks:custom-comfy-settle' } },
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  refundAppSpend: (...a: unknown[]) => mockRefundAppSpend(...(a as [])),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  refundDevSessionBuzz: (...a: unknown[]) => mockRefundDevSessionBuzz(...(a as [])),
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', () => ({
  observeCustomComfyActualBuzz: (...a: unknown[]) => mockObserveActualBuzz(...(a as [])),
  observeCustomComfyWallclockSeconds: (...a: unknown[]) => mockObserveWallclock(...(a as [])),
}));

import {
  persistCustomComfySettle,
  settleCustomComfySpend,
} from '~/server/services/blocks/custom-comfy-settle.service';

const SETTLE_PREFIX = 'system:blocks:custom-comfy-settle';
const BUZZ_KEY = 'system:blocks:buzz-cap:42:2026-07-17';
const APP_KEY = 'system:blocks:app-spend-cap:app_test:2026-07-17';

beforeEach(() => {
  for (const fn of [
    mockSysRedis.get,
    mockSysRedis.set,
    mockSysRedis.del,
    mockSysRedis.decrBy,
    mockRefundAppSpend,
    mockRefundDevSessionBuzz,
    mockObserveActualBuzz,
    mockObserveWallclock,
  ]) {
    fn.mockReset();
  }
  // Sensible defaults: empty store, DEL claims 1 (we win).
  mockSysRedis.get.mockResolvedValue(null);
  mockSysRedis.set.mockResolvedValue(undefined);
  mockSysRedis.del.mockResolvedValue(1);
  mockSysRedis.decrBy.mockResolvedValue(0);
  mockRefundAppSpend.mockResolvedValue(undefined);
  mockRefundDevSessionBuzz.mockResolvedValue(undefined);
});

const DEV_SESSION_ID = 'bki_dev_session';

function seedRecord(
  over: Partial<{
    buzzCapKey: string;
    appSpendKey: string | null;
    devSessionId: string | null;
    ceiling: number;
    engine: string;
    recipe: string;
    submittedAt: number;
  }> = {}
) {
  const record = { buzzCapKey: BUZZ_KEY, appSpendKey: APP_KEY, ceiling: 180, ...over };
  mockSysRedis.get.mockResolvedValue(JSON.stringify(record));
  return record;
}

describe('persistCustomComfySettle', () => {
  it('writes the record keyed by workflowId with a ~25h TTL', async () => {
    await persistCustomComfySettle({
      workflowId: 'wf_1',
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      ceiling: 180,
    });
    expect(mockSysRedis.set).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mockSysRedis.set.mock.calls[0] as [string, string, { EX: number }];
    expect(key).toBe(`${SETTLE_PREFIX}:wf_1`);
    // submittedAt defaults to now() when the caller omits it (observability-only).
    expect(JSON.parse(value)).toEqual({
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      ceiling: 180,
      submittedAt: expect.any(Number),
    });
    expect(opts.EX).toBe(25 * 60 * 60);
  });

  it('carries the engine + recipe + submittedAt when provided (per-engine observability)', async () => {
    await persistCustomComfySettle({
      workflowId: 'wf_1',
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      ceiling: 150,
      engine: 'flux2-klein',
      recipe: 'seamless-pano-360',
      submittedAt: 1_700_000_000_000,
    });
    const [, value] = mockSysRedis.set.mock.calls[0] as [string, string, { EX: number }];
    expect(JSON.parse(value)).toEqual({
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      ceiling: 150,
      engine: 'flux2-klein',
      recipe: 'seamless-pano-360',
      submittedAt: 1_700_000_000_000,
    });
  });

  it('F4: persists the dev-session id when a dev tunnel reserved the ceiling', async () => {
    await persistCustomComfySettle({
      workflowId: 'wf_1',
      buzzCapKey: BUZZ_KEY,
      appSpendKey: null, // dev token → no per-app reserve
      devSessionId: DEV_SESSION_ID,
      ceiling: 180,
    });
    const [, value] = mockSysRedis.set.mock.calls[0] as [string, string, { EX: number }];
    expect(JSON.parse(value)).toEqual({
      buzzCapKey: BUZZ_KEY,
      appSpendKey: null,
      devSessionId: DEV_SESSION_ID,
      ceiling: 180,
      submittedAt: expect.any(Number),
    });
  });

  it('F4: a non-dev submit persists the SAME record shape as before (NO devSessionId field)', async () => {
    await persistCustomComfySettle({
      workflowId: 'wf_1',
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      // devSessionId omitted → non-dev submit
      ceiling: 180,
    });
    const [, value] = mockSysRedis.set.mock.calls[0] as [string, string, { EX: number }];
    const parsed = JSON.parse(value);
    expect(parsed).not.toHaveProperty('devSessionId');
    expect(parsed).toEqual({
      buzzCapKey: BUZZ_KEY,
      appSpendKey: APP_KEY,
      ceiling: 180,
      submittedAt: expect.any(Number),
    });
  });

  it('no-ops on an empty workflowId (never writes)', async () => {
    await persistCustomComfySettle({ workflowId: '', buzzCapKey: BUZZ_KEY, appSpendKey: null, ceiling: 180 });
    expect(mockSysRedis.set).not.toHaveBeenCalled();
  });

  it('swallows a Redis error (best-effort, degrades to reserve-without-settle)', async () => {
    mockSysRedis.set.mockRejectedValue(new Error('redis down'));
    await expect(
      persistCustomComfySettle({ workflowId: 'wf_1', buzzCapKey: BUZZ_KEY, appSpendKey: null, ceiling: 180 })
    ).resolves.toBeUndefined();
  });
});

describe('settleCustomComfySpend', () => {
  it('refunds `ceiling - actual` on BOTH keys and consumes the record (GET+DEL)', async () => {
    seedRecord({ ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    // GET then DEL of the settle key (the atomic single-shot claim).
    expect(mockSysRedis.get).toHaveBeenCalledWith(`${SETTLE_PREFIX}:wf_1`);
    expect(mockSysRedis.del).toHaveBeenCalledWith(`${SETTLE_PREFIX}:wf_1`);
    // Refund the over-reservation (180 - 30 = 150) on the per-user daily key…
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    // …and the per-app aggregate key.
    expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 150);
  });

  it('is IDEMPOTENT — a second terminal observation (DEL===0) refunds nothing', async () => {
    seedRecord({ ceiling: 180 });
    mockSysRedis.del.mockResolvedValue(0); // someone else already claimed it
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
    expect(mockRefundAppSpend).not.toHaveBeenCalled();
  });

  it('no-ops when there is no record (txt2img / non-customComfy workflow)', async () => {
    mockSysRedis.get.mockResolvedValue(null);
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    expect(mockSysRedis.del).not.toHaveBeenCalled();
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
    expect(mockRefundAppSpend).not.toHaveBeenCalled();
  });

  it('refunds NOTHING when the job spent the full ceiling (actual >= ceiling)', async () => {
    seedRecord({ ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 200 });
    expect(mockSysRedis.del).toHaveBeenCalledWith(`${SETTLE_PREFIX}:wf_1`); // still consumed
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
    expect(mockRefundAppSpend).not.toHaveBeenCalled();
  });

  it('refunds the FULL ceiling on a missing/zero actual (e.g. cancel before any accrual)', async () => {
    seedRecord({ ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 0 });
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 180);
    expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 180);
  });

  it('ceils a fractional actual so the remaining reservation is never understated', async () => {
    seedRecord({ ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30.4 });
    // ceil(30.4)=31 stays reserved → refund 180-31 = 149.
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 149);
    expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 149);
  });

  it('skips the per-app refund for a dev token (appSpendKey null) but still refunds the daily key', async () => {
    seedRecord({ appSpendKey: null, ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    expect(mockRefundAppSpend).not.toHaveBeenCalled();
  });

  it('F4: refunds `ceiling - actual` on the dev-session cap too when a devSessionId is present', async () => {
    seedRecord({ appSpendKey: null, devSessionId: DEV_SESSION_ID, ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    // Same over-reservation (180 - 30 = 150) refunded on the per-user daily key…
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    // …and on the dev-tunnel SESSION cap (by session id — refundDevSessionBuzz
    // derives the spend key itself).
    expect(mockRefundDevSessionBuzz).toHaveBeenCalledWith(DEV_SESSION_ID, 150);
    // dev token → no per-app leg.
    expect(mockRefundAppSpend).not.toHaveBeenCalled();
  });

  it('F4: refunds all THREE keys for a non-dev submit that also had an active dev tunnel', async () => {
    seedRecord({ devSessionId: DEV_SESSION_ID, ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 150);
    expect(mockRefundDevSessionBuzz).toHaveBeenCalledWith(DEV_SESSION_ID, 150);
  });

  it('F4: a record WITHOUT a devSessionId (non-dev submit) never touches the dev-session cap', async () => {
    seedRecord({ ceiling: 180 }); // no devSessionId
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 150);
    expect(mockRefundDevSessionBuzz).not.toHaveBeenCalled();
  });

  it('F4: a full-ceiling spend refunds NOTHING on the dev-session cap either', async () => {
    seedRecord({ devSessionId: DEV_SESSION_ID, ceiling: 180 });
    await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 200 });
    expect(mockRefundDevSessionBuzz).not.toHaveBeenCalled();
  });

  it('never throws when the GET fails (leaves the ceiling reserved — stricter)', async () => {
    mockSysRedis.get.mockRejectedValue(new Error('redis down'));
    await expect(settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 })).resolves.toBeUndefined();
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  // ── Per-engine runtime/cost OBSERVABILITY (instrument-ahead-of-demand) ────────
  describe('per-engine metric emit', () => {
    it('observes the settled GPU-runtime (actual Buzz) + wall-clock with engine/recipe labels', async () => {
      seedRecord({
        ceiling: 150,
        engine: 'flux2-klein',
        recipe: 'seamless-pano-360',
        submittedAt: 1_700_000_000_000,
      });
      await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 42 });
      // GPU-runtime ≈ billed actual Buzz — the ceil'd `actual` (42), labeled by engine.
      expect(mockObserveActualBuzz).toHaveBeenCalledWith('flux2-klein', 'seamless-pano-360', 42);
      // Wall-clock incl. queue (submit→terminal observation) — a Number of seconds.
      expect(mockObserveWallclock).toHaveBeenCalledWith(
        'flux2-klein',
        'seamless-pano-360',
        expect.any(Number)
      );
    });

    it('still observes actual Buzz when the job spent the FULL ceiling (emit precedes the refund early-return)', async () => {
      seedRecord({ ceiling: 150, engine: 'flux2-klein', recipe: 'seamless-pano-360' });
      await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 200 });
      // refund is 0 (actual 200 >= ceiling 150) — but the ceiling-pressing case is
      // exactly what we most want to see, so the emit must fire regardless.
      expect(mockObserveActualBuzz).toHaveBeenCalledWith('flux2-klein', 'seamless-pano-360', 200);
      expect(mockSysRedis.decrBy).not.toHaveBeenCalled(); // still no refund
    });

    it('emits actual Buzz but NOT wall-clock when the record has no submittedAt', async () => {
      seedRecord({ ceiling: 90, engine: 'zimage-turbo', recipe: 'seamless-pano-360' });
      await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 20 });
      expect(mockObserveActualBuzz).toHaveBeenCalledWith('zimage-turbo', 'seamless-pano-360', 20);
      expect(mockObserveWallclock).not.toHaveBeenCalled();
    });

    it('emits NEITHER metric for a legacy record with no engine (back-compat safe)', async () => {
      seedRecord({ ceiling: 180 }); // pre-deploy record shape — no engine
      await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 });
      expect(mockObserveActualBuzz).not.toHaveBeenCalled();
      expect(mockObserveWallclock).not.toHaveBeenCalled();
      // …but the refund still happens (observability is orthogonal to settle).
      expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
    });

    it('a `recipe`-less record falls back to the "unknown" recipe label', async () => {
      seedRecord({ ceiling: 90, engine: 'zimage-turbo' }); // engine but no recipe
      await settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 20 });
      expect(mockObserveActualBuzz).toHaveBeenCalledWith('zimage-turbo', 'unknown', 20);
    });

    // ── Finding-1 regression guard: the MONEY path must survive a throwing emit.
    // The two helpers each carry an internal try/catch, but the never-throw
    // guarantee on the refund path must NOT depend on that never regressing —
    // the settle service wraps the emit block in its OWN try/catch. This test
    // makes the emit THROW and asserts the refund DECRBYs on ALL applicable keys
    // still fire (settle completes, Buzz refunded). Without the service-level
    // wrap this throw escapes before the `refund <= 0` check → the DECRBYs never
    // run → RED. (A real fail-on-revert, not a tautology.)
    it('still refunds ALL keys when the actual-Buzz emit THROWS (service-level fail-soft)', async () => {
      mockObserveActualBuzz.mockImplementation(() => {
        throw new Error('metrics registry exploded');
      });
      seedRecord({
        appSpendKey: APP_KEY,
        devSessionId: DEV_SESSION_ID,
        ceiling: 180,
        engine: 'qwen-image',
        recipe: 'seamless-pano-360',
        submittedAt: 1_700_000_000_000,
      });
      await expect(
        settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 })
      ).resolves.toBeUndefined(); // never throws into poll/cancel
      // Every refund leg still fires with the correct over-reservation (180-30=150).
      expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
      expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 150);
      expect(mockRefundDevSessionBuzz).toHaveBeenCalledWith(DEV_SESSION_ID, 150);
    });

    it('still refunds when the WALL-CLOCK emit throws (the second emit is also guarded)', async () => {
      mockObserveWallclock.mockImplementation(() => {
        throw new Error('metrics registry exploded');
      });
      seedRecord({
        ceiling: 180,
        engine: 'qwen-image',
        recipe: 'seamless-pano-360',
        submittedAt: 1_700_000_000_000,
      });
      await expect(
        settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 })
      ).resolves.toBeUndefined();
      expect(mockSysRedis.decrBy).toHaveBeenCalledWith(BUZZ_KEY, 150);
      expect(mockRefundAppSpend).toHaveBeenCalledWith(APP_KEY, 150);
    });
  });
});
