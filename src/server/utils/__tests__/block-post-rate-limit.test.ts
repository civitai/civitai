import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  BLOCK_CATALOG_RATE_LIMIT_MAX,
  BLOCK_POST_APP_RATE_LIMIT_MAX,
  BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS,
  BLOCK_POST_RATE_LIMIT_MAX,
  BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS,
  BLOCK_PUBLISH_RATE_LIMIT_MAX,
  checkBlockPostAppRateLimit,
  checkBlockPostRateLimit,
} from '../block-catalog-rate-limit';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockRedis = redisMock.redis;
// Fixture viewers. Pairwise distinct, and distinct from every ceiling/window
// constant in the module (3, 60, 150, 300, 1200, 3600 …), so a key built from a
// constant instead of the viewer cannot spell either of them.
const VIEWER_A = 8123;
const VIEWER_B = 9417;
const KEY = 'blocks:token-rate-limit:post:bki_test:8123';
// A page app's instance id is `page_<appBlockId>` — one string for every viewer.
const PAGE_INSTANCE = 'page_apb_shared';
const APP_KEY = 'blocks:token-rate-limit:post-app:appblk_test';

/**
 * The DEDICATED post bucket for `blocks.createPostFromApp`, keyed on
 * (instance, viewer).
 *
 * 🔴 THE SUB-NAMESPACE IS THE POINT, AND IT IS THE ONE THING A COPY-PASTE OF THE
 * PUBLISH LIMITER WOULD SILENTLY GET WRONG. Sharing `:publish:` would make one
 * 60-image publish exhaust the posting budget (and vice versa) with no error
 * anywhere — a rate limit that refuses the wrong action looks exactly like a rate
 * limit that works. So the key is asserted literally, not derived.
 */
describe('checkBlockPostRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('uses its OWN `:post:` sub-namespace — never the catalog or publish bucket', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostRateLimit('bki_test', VIEWER_A);

    const key = mockRedis.incrBy.mock.calls[0][0] as string;
    expect(key).toBe(KEY);
    expect(key).not.toContain(':publish:');
    expect(key).not.toContain(':catalog:');
  });

  it('charges exactly ONE token per call regardless of how many images the post carries', async () => {
    // The unit is the POST. The per-image origin cost is charged separately
    // against the publish bucket by the caller; weighting here too would
    // double-charge and make the ceiling mean something nobody intended.
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostRateLimit('bki_test', VIEWER_A);
    expect(mockRedis.incrBy).toHaveBeenCalledWith(KEY, 1);
  });

  it('first hit arms the TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    const res = await checkBlockPostRateLimit('bki_test', VIEWER_A);
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
  });

  it(`allows exactly ${BLOCK_POST_RATE_LIMIT_MAX} and refuses the next one`, async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_RATE_LIMIT_MAX);
    await expect(checkBlockPostRateLimit('bki_test', VIEWER_A)).resolves.toEqual({ allowed: true });

    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockResolvedValue(1200);
    await expect(checkBlockPostRateLimit('bki_test', VIEWER_A)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1200,
    });
  });

  it('the post ceiling is far tighter than the other two — a post is not a catalog read', async () => {
    // A structural claim, not a style one: if someone "harmonises" the three
    // ceilings, the whole reason for a separate bucket disappears. 1200 above and
    // the values here are pairwise distinct, so a mutant substituting any one
    // constant for another is visible.
    expect(BLOCK_POST_RATE_LIMIT_MAX).toBeLessThan(BLOCK_PUBLISH_RATE_LIMIT_MAX);
    expect(BLOCK_POST_RATE_LIMIT_MAX).toBeLessThan(BLOCK_CATALOG_RATE_LIMIT_MAX);
    // …and the window is far LONGER, which is what stops a block posting
    // continuously at the ceiling.
    expect(BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS).toBeGreaterThan(300);
  });

  it('re-asserts a lost TTL rather than leaving an unbounded key', async () => {
    mockRedis.incrBy.mockResolvedValue(2);
    mockRedis.ttl.mockResolvedValue(-1);
    await checkBlockPostRateLimit('bki_test', VIEWER_A);
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('falls back to the full window when the TTL read is unusable', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockResolvedValue(-2);
    await expect(checkBlockPostRateLimit('bki_test', VIEWER_A)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('FAILS OPEN on a redis error — and that is a stated limitation, not a bug', async () => {
    // 🔴 Recorded as a test so nobody reads the bucket as a security control. It
    // is a cost ceiling; the controls that bound abuse are the self-dealing
    // guard, the per-source ownership proofs and the per-post consent confirm.
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockPostRateLimit('bki_test', VIEWER_A)).resolves.toEqual({ allowed: true });
  });

  it('keeps the INSTANCE in the key, so two installs do not share a budget', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostRateLimit('bki_a', VIEWER_A);
    await checkBlockPostRateLimit('bki_b', VIEWER_A);
    expect(mockRedis.incrBy.mock.calls.map((c) => c[0])).toEqual([
      'blocks:token-rate-limit:post:bki_a:8123',
      'blocks:token-rate-limit:post:bki_b:8123',
    ]);
  });

  /**
   * 🔴 THE BEHAVIOUR, NOT THE SPELLING. Everything above answers `incrBy` with a
   * canned number, so it can only see the key string. These two cases put a real
   * counter behind the mock — one integer per key, as Redis keeps — and drive the
   * limiter the way a page app does: several viewers, ONE shared instance id.
   */
  describe('two viewers of the same page-app instance', () => {
    let counters: Map<string, number>;

    beforeEach(() => {
      counters = new Map();
      mockRedis.incrBy.mockImplementation(async (key: string, by: number) => {
        const next = (counters.get(key) ?? 0) + by;
        counters.set(key, next);
        return next;
      });
      // 1777: distinct from the window (3600) and every other constant here.
      mockRedis.ttl.mockResolvedValue(1777);
    });

    it('each viewer gets their OWN allowance — B is not refused after A used all 3', async () => {
      const a = [
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_A),
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_A),
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_A),
      ];
      expect(a).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);

      // Viewer B has posted nothing. Same app, same instance id, a different person.
      const b = [
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_B),
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_B),
        await checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_B),
      ];
      expect(b).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);

      // Two counters, three each — not one counter at six.
      expect([...counters.entries()].sort()).toEqual([
        ['blocks:token-rate-limit:post:page_apb_shared:8123', 3],
        ['blocks:token-rate-limit:post:page_apb_shared:9417', 3],
      ]);
    });

    it('one viewer is still refused on their 4th within the window — and only that viewer', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
          allowed: true,
        });
      }
      await expect(checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 1777,
      });
      // A being over the ceiling does not reach B.
      await expect(checkBlockPostRateLimit(PAGE_INSTANCE, VIEWER_B)).resolves.toEqual({
        allowed: true,
      });
    });
  });
});

/**
 * The APP-AGGREGATE post bucket — the ceiling the per-(instance, viewer) one
 * structurally cannot express.
 *
 * 🔴 WHAT THIS SUITE IS ACTUALLY FOR: the other post bucket is keyed on one VIEWER
 * of one INSTALL, so an app with N of those posts N × its ceiling per hour and no
 * ceiling anywhere sees the total. Every case below is about the KEY — that it is
 * derived from the app, that it lands in its own sub-namespace, and that two apps
 * do not share it. A limiter that refused correctly on a single app while being
 * keyed on a constant would be globally wrong and locally invisible.
 */
describe('checkBlockPostAppRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('uses its OWN `:post-app:` sub-namespace — never the per-viewer post bucket', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostAppRateLimit('appblk_test');

    const key = mockRedis.incrBy.mock.calls[0][0] as string;
    expect(key).toBe(APP_KEY);
    // Sharing `:post:` would make the app bucket and the per-viewer bucket the same
    // counter, so exhausting one would exhaust the other with no error anywhere.
    expect(key).not.toBe(KEY);
    expect(key).not.toContain(':publish:');
    expect(key).not.toContain(':catalog:');
  });

  it('charges exactly ONE token per call — the same unit as the per-viewer bucket', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostAppRateLimit('appblk_test');
    expect(mockRedis.incrBy).toHaveBeenCalledWith(APP_KEY, 1);
  });

  it('first hit arms the TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    const res = await checkBlockPostAppRateLimit('appblk_test');
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.expire).toHaveBeenCalledWith(
      APP_KEY,
      BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it(`allows exactly ${BLOCK_POST_APP_RATE_LIMIT_MAX} and REFUSES the next one`, async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_APP_RATE_LIMIT_MAX);
    await expect(checkBlockPostAppRateLimit('appblk_test')).resolves.toEqual({ allowed: true });

    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_APP_RATE_LIMIT_MAX + 1);
    // 777 is distinct from every window/ceiling constant in this module, so a
    // mutant returning a constant instead of the TTL is visible.
    mockRedis.ttl.mockResolvedValue(777);
    await expect(checkBlockPostAppRateLimit('appblk_test')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 777,
    });
  });

  it('🔴 two DIFFERENT apps get DIFFERENT keys — the bucket is app-scoped, not global', async () => {
    // The half that proves app-scoping. A limiter keyed on a constant passes the
    // ceiling case above and fails only here.
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPostAppRateLimit('appblk_alpha');
    await checkBlockPostAppRateLimit('appblk_beta');

    const [a, b] = mockRedis.incrBy.mock.calls.map((c) => c[0] as string);
    expect(a).toContain('appblk_alpha');
    expect(b).toContain('appblk_beta');
    expect(a).not.toBe(b);
  });

  it('is GENEROUS relative to the per-viewer bucket — a popular app is not throttled', async () => {
    // A structural claim about the relationship, not the literals: the aggregate
    // must be far above one viewer's allowance or it re-creates the failure it
    // was added to avoid, and a too-tight aggregate reaches users as "posting is
    // broken" rather than as a rate limit.
    expect(BLOCK_POST_APP_RATE_LIMIT_MAX).toBeGreaterThan(BLOCK_POST_RATE_LIMIT_MAX * 10);
    // Same window, so the two numbers are directly comparable.
    expect(BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS).toBe(BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('re-asserts a lost TTL rather than leaving an unbounded key', async () => {
    mockRedis.incrBy.mockResolvedValue(2);
    mockRedis.ttl.mockResolvedValue(-1);
    await checkBlockPostAppRateLimit('appblk_test');
    expect(mockRedis.expire).toHaveBeenCalledWith(
      APP_KEY,
      BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('falls back to the full window when the TTL read is unusable', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POST_APP_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockResolvedValue(-2);
    await expect(checkBlockPostAppRateLimit('appblk_test')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('FAILS OPEN on a redis error — the same stated limitation as its siblings', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockPostAppRateLimit('appblk_test')).resolves.toEqual({ allowed: true });
  });
});
