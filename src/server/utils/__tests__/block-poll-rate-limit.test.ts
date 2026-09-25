import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the App Blocks POLL per-instance rate limiter
 * (`checkBlockPollRateLimit`) — clawgate #569, the bucket `blocks.pollWorkflow` charges.
 *
 * Four contracts, the same four its three siblings hold, plus one that is specific to this
 * bucket existing at all:
 *   (a) under/at the ceiling → allowed (the boundary is inclusive);
 *   (b) over the ceiling → refused, with the LIVE TTL as Retry-After;
 *   (c) any redis error → FAIL OPEN — a Redis incident must not stall a generation the
 *       viewer has already been charged for;
 *   (d) 🔴 the KEY is in its own `:poll:` sub-namespace. That is not cosmetic and it is not
 *       implied by any of the others: the whole argument for a fourth bucket is that a poll
 *       loop must not be able to exhaust a catalog read's allowance. If the key collided with
 *       `:catalog:` every other assertion in this file would still pass, and the separation
 *       would exist only in the comments. Pinned by VALUE below.
 *
 * The redis cache client is mocked so no real connection is constructed.
 */

import {
  checkBlockPollRateLimit,
  BLOCK_POLL_RATE_LIMIT_MAX,
  BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS,
  BLOCK_CATALOG_RATE_LIMIT_MAX,
  BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS,
} from '../block-catalog-rate-limit';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockRedis = redisMock.redis;

const VIEWER = 42;
// 🔴 THE VIEWER IS IN THE KEY, and that is the property this bucket exists to have.
// `blockInstanceId` is `page_<appBlockId>` for a page app — one string shared by every
// viewer of it — so a key without the viewer would make this an app-wide poll ceiling.
const KEY = `blocks:token-rate-limit:poll:bki_test:${VIEWER}`;

describe('checkBlockPollRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('uses its OWN key namespace — never the catalog bucket', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPollRateLimit('bki_test', VIEWER);
    expect(mockRedis.incrBy).toHaveBeenCalledWith(KEY, 1);
    // Stated the other way round too, so a future edit that "tidies" the namespace into a
    // shared one has to delete an explicit refusal rather than quietly change a string.
    expect(mockRedis.incrBy).not.toHaveBeenCalledWith(
      'blocks:token-rate-limit:catalog:bki_test',
      1
    );
  });

  it('SEPARATES TWO VIEWERS of the SAME install — the whole point of the second key half', async () => {
    // 🔴 A key-string assertion alone cannot see this: `…:bki_test:42` is a correct
    // string whether or not the second viewer gets their own bucket. This drives two
    // viewers and requires two DIFFERENT keys, which is the property, not the spelling.
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockPollRateLimit('bki_test', VIEWER);
    await checkBlockPollRateLimit('bki_test', VIEWER + 1);

    const keys = mockRedis.incrBy.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(`blocks:token-rate-limit:poll:bki_test:${VIEWER}`);
    expect(keys).toContain(`blocks:token-rate-limit:poll:bki_test:${VIEWER + 1}`);
  });

  it('is sized DIFFERENTLY from the catalog bucket — the reason it is a separate bucket', async () => {
    // 🔴 A CONTROL ON THE PREMISE, not on the code path. The dedicated bucket exists because
    // poll is sized against concurrent workflows × cadence while catalog is sized against a
    // person scrolling a selector. If the two pairs ever became equal the separation would be
    // pure ceremony, and nothing else here would notice.
    expect([BLOCK_POLL_RATE_LIMIT_MAX, BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS]).not.toEqual([
      BLOCK_CATALOG_RATE_LIMIT_MAX,
      BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS,
    ]);
    // And the window is long enough to describe a RATE rather than a burst: one long poll can
    // occupy 15s of wall clock (MAX_BLOCK_POLL_WAIT_SECONDS), so a window at or below that
    // would be shorter than a single legitimate request.
    expect(BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS).toBeGreaterThan(15);
  });

  it('first hit of a window → allowed and arms the TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    const res = await checkBlockPollRateLimit('bki_test', VIEWER);
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('AT the ceiling → still allowed (the boundary is inclusive)', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POLL_RATE_LIMIT_MAX);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });
  });

  it('ONE PAST the ceiling → REFUSED, with the live TTL as Retry-After', async () => {
    // The off-by-one is the whole contract: `<=` vs `<` is the difference between refusing the
    // 1200th request and the 1201st, and a fixture at the ceiling alone cannot see it.
    mockRedis.incrBy.mockResolvedValue(BLOCK_POLL_RATE_LIMIT_MAX + 1);
    // Deliberately NOT the window length — a Retry-After hardcoded to the window would satisfy
    // an assertion that used the window here.
    mockRedis.ttl.mockResolvedValue(9);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 9,
    });
  });

  it('does NOT reset the TTL on a live window', async () => {
    mockRedis.incrBy.mockResolvedValue(5);
    mockRedis.ttl.mockResolvedValue(31);
    await checkBlockPollRateLimit('bki_test', VIEWER);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('re-asserts a LOST TTL on a non-first hit — a TTL-less key would lock forever', async () => {
    mockRedis.incrBy.mockResolvedValue(5);
    mockRedis.ttl.mockResolvedValue(-1);
    await checkBlockPollRateLimit('bki_test', VIEWER);
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('over the ceiling with an unset TTL → falls back to the full window', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POLL_RATE_LIMIT_MAX + 10);
    mockRedis.ttl.mockResolvedValue(-2);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('🔴 a NON-THROWING bad reply → FAIL OPEN — the mode a `catch` cannot see', async () => {
    // 🔴 THIS COVERS THE SHARED `checkFixedWindow` BODY, so it is the killing test for all five
    // buckets, not just this one. Added after MEASURING that the guard it covers survived its own
    // deletion: with the `typeof count !== 'number'` line removed, this file plus the catalog,
    // post and bridge-guard suites were 55/55 GREEN. A guard nothing can kill is not a guard.
    //
    // WHY IT MATTERS IN PRODUCTION: a client that answers `undefined`/`null` instead of raising
    // makes `count <= max` FALSE — `undefined <= 1200` is false — so the limiter REFUSES, while
    // this file's header, the constants' docblocks, every router call site and the decision ledger
    // all promise unconditional fail-open. The `catch` below guards against THROWS; this guards
    // against ANSWERS, and only one of the two was present.
    //
    // A non-throwing bad reply is not hypothetical: it is precisely what an unstubbed test double
    // returns, which is how two router suites that do not mock this module turned red.
    mockRedis.incrBy.mockResolvedValue(undefined as never);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });

    // The same for an explicit null, so the assertion pins the CLASS rather than one spelling.
    mockRedis.incrBy.mockResolvedValue(null as never);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });

    // …and NaN, which is a number and would otherwise slip past a bare `typeof` check while making
    // every comparison below it false.
    mockRedis.incrBy.mockResolvedValue(NaN as never);
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });
  });

  it('redis error on INCR → FAIL OPEN', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });
  });

  it('redis error on the over-limit TTL read → FAIL OPEN, not a 429 on a half-broken redis', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_POLL_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockPollRateLimit('bki_test', VIEWER)).resolves.toEqual({ allowed: true });
  });
});
