import { describe, it, expect, vi, beforeEach } from 'vitest';

// swap.ts reaches sysRedis via `../redis` (getSysRedis). Mock that so each test injects a fake sys
// redis (or null). The unit under test — the single-use burn and crucially its fail-CLOSED behavior
// when the store is absent — stays real.
const h = vi.hoisted(() => ({ getSysRedis: vi.fn() }));
vi.mock('../../redis', () => ({ getSysRedis: h.getSysRedis }));

import { consumeSwapToken } from '../swap';

// Minimal in-memory sys redis: setNX (first-write-wins), set/get (string values), expire (no-op).
function makeSysRedis() {
  const store = new Map<string, unknown>();
  return {
    _store: store,
    setNX: vi.fn(async (k: string, v: unknown) => {
      if (store.has(k)) return false;
      store.set(k, v);
      return true;
    }),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    expire: vi.fn(async () => 1),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('consumeSwapToken (single-use)', () => {
  it('allows the FIRST redemption and rejects a replay', async () => {
    const sys = makeSysRedis();
    h.getSysRedis.mockReturnValue(sys);
    expect(await consumeSwapToken('jti-1')).toBe(true); // first
    expect(await consumeSwapToken('jti-1')).toBe(false); // replay
  });

  it('fails CLOSED (false) when sysRedis is unconfigured — single-use must not silently disable', async () => {
    h.getSysRedis.mockReturnValue(null);
    // Previously returned true (replay wide open). Must reject so swaps can't be replayed.
    expect(await consumeSwapToken('jti-x')).toBe(false);
  });

  it('fails CLOSED (false) when redis throws', async () => {
    const sys = makeSysRedis();
    sys.setNX.mockRejectedValue(new Error('connection reset'));
    h.getSysRedis.mockReturnValue(sys);
    expect(await consumeSwapToken('jti-err')).toBe(false);
  });

  it('returns true (burn succeeded) even if the best-effort expire fails', async () => {
    // The TTL is best-effort (a lingering marker is safe — it only over-protects). A failed expire
    // must NOT turn a successful first-redemption into a rejection.
    const sys = makeSysRedis();
    sys.expire.mockRejectedValue(new Error('expire failed'));
    h.getSysRedis.mockReturnValue(sys);
    expect(await consumeSwapToken('jti-exp')).toBe(true);
  });

  it('never returns true without a successful setNX (a falsey setNX denies)', async () => {
    // Guards the invariant: the ONLY path to true is setNX reporting a fresh write.
    const sys = makeSysRedis();
    sys.setNX.mockResolvedValue(false); // key already present → replay
    h.getSysRedis.mockReturnValue(sys);
    expect(await consumeSwapToken('jti-dup')).toBe(false);
  });
});
