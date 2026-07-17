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

const { mockSysRedis, mockRefundAppSpend } = vi.hoisted(() => ({
  mockSysRedis: {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 1),
    decrBy: vi.fn(async () => 0),
  },
  mockRefundAppSpend: vi.fn(async () => undefined),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { CUSTOM_COMFY_SETTLE: 'system:blocks:custom-comfy-settle' } },
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  refundAppSpend: (...a: unknown[]) => mockRefundAppSpend(...(a as [])),
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
  ]) {
    fn.mockReset();
  }
  // Sensible defaults: empty store, DEL claims 1 (we win).
  mockSysRedis.get.mockResolvedValue(null);
  mockSysRedis.set.mockResolvedValue(undefined);
  mockSysRedis.del.mockResolvedValue(1);
  mockSysRedis.decrBy.mockResolvedValue(0);
  mockRefundAppSpend.mockResolvedValue(undefined);
});

function seedRecord(over: Partial<{ buzzCapKey: string; appSpendKey: string | null; ceiling: number }> = {}) {
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
    expect(JSON.parse(value)).toEqual({ buzzCapKey: BUZZ_KEY, appSpendKey: APP_KEY, ceiling: 180 });
    expect(opts.EX).toBe(25 * 60 * 60);
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

  it('never throws when the GET fails (leaves the ceiling reserved — stricter)', async () => {
    mockSysRedis.get.mockRejectedValue(new Error('redis down'));
    await expect(settleCustomComfySpend({ workflowId: 'wf_1', actualCost: 30 })).resolves.toBeUndefined();
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });
});
