import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct unit coverage for the GEN idempotency REDIS PRIMITIVES
 * (`claimGenIdempotency` / `finalizeGenIdempotency` / `releaseGenIdempotency`),
 * exercised against an in-memory redis mock so the SET-NX acquire/replay/
 * in-progress state machine, the finalize→replay round-trip, release, and the
 * fail-closed posture are tested for real (the router tests mock these away).
 *
 * Mirrors block-tip-rate-limit.test.ts (the sibling tip idempotency layer).
 */

const { sysStore, sysTtls, mockSys } = vi.hoisted(() => {
  const sysStore = new Map<string, string>();
  const sysTtls = new Map<string, number>();
  const mockSys = {
    set: vi.fn(async (k: string, val: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && sysStore.has(k)) return null; // NX: only set when absent
      sysStore.set(k, val);
      if (opts?.EX != null) sysTtls.set(k, opts.EX);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => sysStore.get(k) ?? null),
    del: vi.fn(async (k: string) => {
      const had = sysStore.has(k);
      sysStore.delete(k);
      sysTtls.delete(k);
      return had ? 1 : 0;
    }),
  };
  return { sysStore, sysTtls, mockSys };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSys,
  REDIS_SYS_KEYS: { BLOCKS: { GEN_IDEM: 'system:blocks:gen-idem' } },
}));

import {
  BLOCK_IDEMPOTENCY_KEY_REGEX,
  ORCHESTRATOR_EXTERNAL_ID_MAX,
  ORCHESTRATOR_EXTERNAL_ID_REGEX,
  claimGenIdempotency,
  composeBlockExternalId,
  finalizeGenIdempotency,
  releaseGenIdempotency,
} from '../block-gen-idempotency';

beforeEach(() => {
  vi.clearAllMocks();
  sysStore.clear();
  sysTtls.clear();
});

describe('claimGenIdempotency', () => {
  it('ACQUIRES on the first claim (SET NX) with a per-(user, app, key) key + TTL', async () => {
    const claim = await claimGenIdempotency(42, 'apb_x', 'key-1');
    expect(claim).toEqual({ state: 'acquired', key: 'system:blocks:gen-idem:42:apb_x:key-1' });
    // In-progress sentinel written with an EX TTL (10 min).
    expect(mockSys.set).toHaveBeenCalledWith(
      'system:blocks:gen-idem:42:apb_x:key-1',
      ' in-progress',
      { NX: true, EX: 10 * 60 }
    );
    expect(sysTtls.get('system:blocks:gen-idem:42:apb_x:key-1')).toBe(10 * 60);
  });

  it('returns IN_PROGRESS for a concurrent same-key claim while the first is unfinalized', async () => {
    const first = await claimGenIdempotency(42, 'apb_x', 'key-1');
    expect(first.state).toBe('acquired');
    // Second claim before the first finalizes → the sentinel is present, not a
    // terminal result → in_progress (the router 409s; never a 2nd reservation).
    const second = await claimGenIdempotency(42, 'apb_x', 'key-1');
    expect(second).toEqual({ state: 'in_progress' });
  });

  it('REPLAYS the cached terminal result after finalize (no re-run)', async () => {
    const first = await claimGenIdempotency<{ snapshot: { workflowId: string } }>(
      42,
      'apb_x',
      'key-1'
    );
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeGenIdempotency(first.key, { snapshot: { workflowId: 'wf_1' } });

    const replay = await claimGenIdempotency<{ snapshot: { workflowId: string } }>(
      42,
      'apb_x',
      'key-1'
    );
    expect(replay).toEqual({ state: 'replay', result: { snapshot: { workflowId: 'wf_1' } } });
  });

  it('a malformed stored value is treated as IN_PROGRESS (never re-run a money path)', async () => {
    // Simulate a corrupt / partially-written record under the key.
    sysStore.set('system:blocks:gen-idem:42:apb_x:key-1', 'not json');
    const claim = await claimGenIdempotency(42, 'apb_x', 'key-1');
    expect(claim).toEqual({ state: 'in_progress' });
  });

  it('FAILS CLOSED — throws on a redis error at claim time (money path must not dedupe blind)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimGenIdempotency(42, 'apb_x', 'key-1')).rejects.toThrow('redis down');
  });

  it('key is INJECTIVE across (user, app, key) — no cross-app / cross-user collision', async () => {
    const a = await claimGenIdempotency(42, 'apb_x', 'k');
    const b = await claimGenIdempotency(42, 'apb_y', 'k'); // different app
    const c = await claimGenIdempotency(99, 'apb_x', 'k'); // different user
    const keys = [a, b, c].map((x) => (x.state === 'acquired' ? x.key : ''));
    expect(new Set(keys).size).toBe(3);
  });
});

describe('releaseGenIdempotency', () => {
  it('deletes the claim so a genuine retry with the same key ACQUIRES fresh', async () => {
    const first = await claimGenIdempotency(42, 'apb_x', 'key-1');
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await releaseGenIdempotency(first.key);
    expect(sysStore.has(first.key)).toBe(false);
    // A subsequent claim wins the sentinel again (transient-reject retry path).
    const again = await claimGenIdempotency(42, 'apb_x', 'key-1');
    expect(again.state).toBe('acquired');
  });

  it('is best-effort — never throws on a redis error', async () => {
    mockSys.del.mockRejectedValueOnce(new Error('redis down'));
    await expect(releaseGenIdempotency('system:blocks:gen-idem:42:apb_x:key-1')).resolves.toBeUndefined();
  });
});

describe('finalizeGenIdempotency', () => {
  it('is best-effort — a failed write never throws (falls back to orchestrator dedupe)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      finalizeGenIdempotency('system:blocks:gen-idem:42:apb_x:key-1', { snapshot: {} })
    ).resolves.toBeUndefined();
  });
});

describe('charset + externalId guards (audit 🟢)', () => {
  it('accepts UUID-ish keys (crypto.randomUUID + the SDK idem-<base36> fallback)', () => {
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('3f1a9c2e-5b6d-4e7f-8a90-1b2c3d4e5f60')).toBe(true);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('idem-abc123-def456')).toBe(true);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('A_z-0')).toBe(true);
  });

  it('rejects control chars, whitespace, colons, and over-length keys', () => {
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('has space')).toBe(false);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('new\nline')).toBe(false);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('has:colon')).toBe(false);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('')).toBe(false);
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('a'.repeat(65))).toBe(false);
    // The bound is 64 so the composed externalId can never approach the REAL
    // orchestrator ceiling of 128.
    expect(BLOCK_IDEMPOTENCY_KEY_REGEX.test('a'.repeat(64))).toBe(true);
  });

  it('composeBlockExternalId emits an id the ORCHESTRATOR accepts (charset + length)', () => {
    // 🔴 The orchestrator validates `^[A-Za-z0-9_-]+$` (max 128) behind
    // [ApiController] → an out-of-charset id is a 400, not a truncation. A
    // colon-delimited shape (the pre-fix behavior) would 400 every keyed submit.
    expect(composeBlockExternalId('apb_x', 'key-1')).toBe('blk05apb_xkey-1');
    expect(composeBlockExternalId('apb_x', 'key-1')).not.toContain(':');

    const realistic = composeBlockExternalId(
      'apb_0123456789abcdefghijklmnop',
      '3f1a9c2e-5b6d-4e7f-8a90-1b2c3d4e5f60'
    );
    expect(ORCHESTRATOR_EXTERNAL_ID_REGEX.test(realistic)).toBe(true);
    expect(realistic.length).toBeLessThanOrEqual(ORCHESTRATOR_EXTERNAL_ID_MAX);

    // Worst realistic case: an `ephemeral-<40-char slug>` dev id + a max-length key.
    const worst = composeBlockExternalId(`ephemeral-${'s'.repeat(40)}`, 'k'.repeat(64));
    expect(ORCHESTRATOR_EXTERNAL_ID_REGEX.test(worst)).toBe(true);
    expect(worst.length).toBeLessThanOrEqual(ORCHESTRATOR_EXTERNAL_ID_MAX);
  });

  it('composeBlockExternalId is INJECTIVE across (app, key) even when both contain - and _', () => {
    // No delimiter is safe (both components may contain `-`/`_`), so the 2-digit
    // length prefix is what pins the split. These pairs concatenate to the same
    // raw string and MUST still produce distinct externalIds.
    const a = composeBlockExternalId('ephemeral-my', 'app-key');
    const b = composeBlockExternalId('ephemeral-my-app', 'key');
    expect(a).not.toBe(b);

    const seen = new Set(
      (
        [
          ['apb_a', 'b-c'],
          ['apb_a-b', 'c'],
          ['apb_a_b', 'c'],
          ['apb_a', 'b_c'],
        ] as const
      ).map(([app, key]) => composeBlockExternalId(app, key))
    );
    expect(seen.size).toBe(4);
  });

  it('composeBlockExternalId throws (fail-closed) rather than emit an id the orchestrator rejects', () => {
    // Each guard trips BEFORE any cap reservation → no money moves.
    expect(() => composeBlockExternalId('a'.repeat(100), 'k')).toThrow(/outside 1\.\.99/);
    expect(() => composeBlockExternalId('', 'k')).toThrow(/outside 1\.\.99/);
    expect(() => composeBlockExternalId('a'.repeat(99), 'k'.repeat(64))).toThrow(/too long/);
    // An appBlockId straying outside the orchestrator alphabet is caught too.
    expect(() => composeBlockExternalId('apb:bad', 'k')).toThrow(/characters the orchestrator/);
  });
});
