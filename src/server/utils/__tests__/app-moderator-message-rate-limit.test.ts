import { beforeEach, describe, expect, it } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The mod-message abuse controls.
 *
 * 🔴 THE REASON THIS FILE EXISTS AT ALL is the trap it defends: the tRPC `rateLimit`
 * middleware SHORT-CIRCUITS for moderators (`if (ctx.user?.isModerator …) return
 * next()`), so on a `moderatorProcedure` it caps nothing while looking like a limit in
 * the router source, in review and in a diff. Every assertion here is therefore about a
 * limiter that ACTUALLY counts — and the last describe block pins the router-side half:
 * that no `rateLimit()` was wired onto the proc under the illusion that it works.
 *
 * The limiter runs against the canonical `redisMock`. Nothing here mocks the module
 * under test, so an INCR that never happens is visible as a call count of zero rather
 * than as a declared return value.
 */

const { checkModMessageModeratorQuota, checkModMessageListingQuota, MOD_MESSAGE_MAX_PER_LISTING, MOD_MESSAGE_MAX_PER_MODERATOR, MOD_MESSAGE_WINDOW_SECONDS } =
  await import('~/server/utils/app-moderator-message-rate-limit');

beforeEach(() => {
  // Per-FILE reset for the shared hybrid mocks — declare per test.
  redisMock.redis.incrBy.mockReset().mockResolvedValue(1);
  redisMock.redis.expire.mockReset().mockResolvedValue(true);
  redisMock.redis.ttl.mockReset().mockResolvedValue(MOD_MESSAGE_WINDOW_SECONDS);
});

describe('the two windows are SEPARATE keys', () => {
  it('🔴 a moderator and a listing never share a counter', async () => {
    // If both helpers wrote one key, the per-listing ceiling would be silently
    // consumed by the moderator's own sends and vice versa — and the pair would still
    // "have a rate limit". The two keys must be distinct AND each must name its own
    // subject, so a second moderator gets a second budget while the recipient does not.
    await checkModMessageModeratorQuota(8);
    await checkModMessageListingQuota('apl_live');
    const keys = redisMock.redis.incrBy.mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('8');
    expect(keys[1]).toContain('apl_live');
  });

  it('different moderators, and different listings, get different keys', async () => {
    await checkModMessageModeratorQuota(8);
    await checkModMessageModeratorQuota(9);
    await checkModMessageListingQuota('apl_a');
    await checkModMessageListingQuota('apl_b');
    const keys = redisMock.redis.incrBy.mock.calls.map((c) => c[0] as string);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('the fixed window', () => {
  it('allows a send at exactly the ceiling and refuses the one after', async () => {
    // 🔴 The boundary in BOTH directions. `<=` vs `<` is a one-character mutation that
    // an at-the-limit-only test and an over-the-limit-only test each survive.
    redisMock.redis.incrBy.mockResolvedValue(MOD_MESSAGE_MAX_PER_MODERATOR);
    expect(await checkModMessageModeratorQuota(8)).toEqual({ allowed: true });

    redisMock.redis.incrBy.mockResolvedValue(MOD_MESSAGE_MAX_PER_MODERATOR + 1);
    expect(await checkModMessageModeratorQuota(8)).toMatchObject({ allowed: false });
  });

  it('the LISTING ceiling is its own number, not the moderator one', async () => {
    // The two constants differ (5 vs 30), so a limiter that used one number for both
    // would let a single app receive six times the intended volume. Feeding a count
    // that is over the listing ceiling and under the moderator ceiling separates them.
    expect(MOD_MESSAGE_MAX_PER_LISTING).toBeLessThan(MOD_MESSAGE_MAX_PER_MODERATOR);
    const between = MOD_MESSAGE_MAX_PER_LISTING + 1;
    expect(between).toBeLessThanOrEqual(MOD_MESSAGE_MAX_PER_MODERATOR);
    redisMock.redis.incrBy.mockResolvedValue(between);
    expect(await checkModMessageListingQuota('apl_live')).toMatchObject({ allowed: false });
    expect(await checkModMessageModeratorQuota(8)).toEqual({ allowed: true });
  });

  it('arms the TTL on the FIRST send of a window', async () => {
    redisMock.redis.incrBy.mockResolvedValue(1);
    await checkModMessageModeratorQuota(8);
    expect(redisMock.redis.expire).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.expire.mock.calls[0][1]).toBe(MOD_MESSAGE_WINDOW_SECONDS);
  });

  it('does NOT extend an active window on a later send', async () => {
    // Re-arming every send would make the window sliding-forever: a mod sending once a
    // minute would never have their count reset, and the ceiling would become a
    // lifetime cap. Note this is the case a "TTL is always set" test gets backwards.
    redisMock.redis.incrBy.mockResolvedValue(3);
    redisMock.redis.ttl.mockResolvedValue(1200);
    await checkModMessageModeratorQuota(8);
    expect(redisMock.redis.expire).not.toHaveBeenCalled();
  });

  it('SELF-HEALS a key that lost its TTL', async () => {
    // An INCR that raced an expiring key leaves a TTL-less counter that would refuse
    // this moderator forever. -1 means "no TTL" in Redis.
    redisMock.redis.incrBy.mockResolvedValue(3);
    redisMock.redis.ttl.mockResolvedValue(-1);
    await checkModMessageModeratorQuota(8);
    expect(redisMock.redis.expire).toHaveBeenCalledTimes(1);
  });

  it('reports the live TTL as retry-after', async () => {
    redisMock.redis.incrBy.mockResolvedValue(MOD_MESSAGE_MAX_PER_LISTING + 1);
    redisMock.redis.ttl.mockResolvedValue(742);
    expect(await checkModMessageListingQuota('apl_live')).toEqual({
      allowed: false,
      retryAfterSeconds: 742,
    });
  });

  it('falls back to the full window when the TTL read is unusable', async () => {
    redisMock.redis.incrBy.mockResolvedValue(MOD_MESSAGE_MAX_PER_LISTING + 1);
    redisMock.redis.ttl.mockResolvedValue(-2);
    expect(await checkModMessageListingQuota('apl_live')).toEqual({
      allowed: false,
      retryAfterSeconds: MOD_MESSAGE_WINDOW_SECONDS,
    });
  });
});

describe('fail direction', () => {
  it('FAILS OPEN when Redis errors', async () => {
    // Deliberate, and documented in the module: the accountability mechanism is the
    // Postgres audit row (written before delivery, carrying actorUserId), not the
    // counter. Failing closed would let a Redis incident silently block moderation
    // correspondence while every other mod action kept working.
    redisMock.redis.incrBy.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await checkModMessageModeratorQuota(8)).toEqual({ allowed: true });
    expect(await checkModMessageListingQuota('apl_live')).toEqual({ allowed: true });
  });

  it('fails open when the TTL arm errors mid-window', async () => {
    redisMock.redis.incrBy.mockResolvedValue(1);
    redisMock.redis.expire.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await checkModMessageModeratorQuota(8)).toEqual({ allowed: true });
  });
});
