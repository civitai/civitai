import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  checkPrivateRunImpressionRateLimit,
  PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX,
  PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
} from '../private-run-impression-rate-limit';

/**
 * Unit coverage for the per-viewer COST ceiling in front of the private-run analytics
 * gate's expensive leg (`blocks/private-run-impression.service.ts` gate 3.5).
 *
 * Six contracts, and the first two are the ones no sibling limiter has:
 *   (a) 🔴 THE KEY IS THE VIEWER AND NOTHING ELSE. Asserted as a WHOLE STRING, not a
 *       prefix: the defect this bucket must not grow is an `appBlockId` appended to the
 *       key, which is body-chosen and would hand a caller a fresh bucket per invented id.
 *       A `toContain`-style check passes happily with the app id on the end.
 *   (b) 🔴 THE WINDOW IS ARMED BY THE COMMAND THAT CREATES THE KEY (`SET … NX EX`), so a
 *       TTL-less window is unreachable and there is deliberately NO self-heal — the
 *       opposite choice from `block-catalog-rate-limit.ts`, whose `INCR`-then-`EXPIRE` is
 *       not atomic and therefore needs one. Pinned both ways: the `EX` is asserted by
 *       value, and `expire` is asserted NEVER called.
 *   (c) the boundary, driven through a real counter rather than a pinned reply.
 *   (d) fail-open on a THROW and on a BAD ANSWER — a `catch` guards against throws, the
 *       `typeof` guard against answers, and the second is load-bearing only because of the
 *       comparison's polarity (see the implementation's comment).
 *   (e) `retryAfterSeconds` from the live TTL, falling back to the FULL window when the
 *       TTL is unset or unreadable.
 *   (f) the refusal counter — a real prom-registry read, because a refusal here has a
 *       CORRECTNESS consequence (the impression gets recorded, so it reaches the owner)
 *       and a silent refusal is the reassuring-zero shape.
 *
 * ⚠️ LABEL THIS FILE HONESTLY: it is NOT regression coverage. The limiter does not exist on
 * the pre-change tree, so nothing here could be watched failing against a build that had
 * the defect. The red-then-green matrix for the BEHAVIOUR lives in
 * `blocks/__tests__/private-run-impression.service.test.ts`, which is driven through the
 * gate and whose new cases were each watched red with gate 3.5 removed.
 *
 * `sysRedis` is the CANONICAL shared mock (`~/__tests__/mocks/redis.mock`). A per-file
 * registration of the redis-client specifier would both trip `no-direct-shared-module-mock`
 * and force the key constants to be hand-typed, which is exactly the drift
 * `no-hand-typed-redis-key-constants` exists to stop. Using the shared mock means the key
 * below is compared against the REAL production constant.
 *
 * ⚠️ AND DO NOT SPELL THAT REGISTRATION OUT IN PROSE HERE: `no-direct-shared-module-mock`
 * scans RAW TEXT for the call shape, so even a comment quoting it flags this file. That
 * false positive is a documented, deliberate trade in the guard itself — the fix is the
 * reword, not a baseline entry.
 */

const METRIC = 'civitai_app_block_private_run_impression_rate_limit_refusals_total';
const VIEWER = 4242;
/** The whole key, spelled out. An extra segment must fail this. */
const KEY = `${REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_IMPRESSION_RATE_LIMIT}:${VIEWER}`;

/** Every `set` the MULTI issued, as `[key, value, options]`. */
let setCalls: Array<[string, unknown, unknown]> = [];
/** The fake keyspace, so the counter really increments instead of being pinned. */
let store: Map<string, number>;
/** When set, `exec` returns this instead of the real op results. */
let execOverride: unknown[] | null | undefined | false = false;
let execThrows = false;

/**
 * A faithful-enough `MULTI: SET k 0 NX EX w` + `INCR k`: the `SET` creates the key at 0
 * only when absent (and reports `null` when it did nothing, like a real NX miss), and the
 * `INCR` returns the post-increment value. Faithful enough matters — a mock that always
 * returns a fixed count cannot see the boundary or the rotation property.
 */
function armSysRedis() {
  redisMock.sysRedis.multi.mockImplementation(() => {
    const ops: Array<() => unknown> = [];
    const chain: Record<string, unknown> = {
      set: (key: string, value: unknown, options: unknown) => {
        setCalls.push([key, value, options]);
        ops.push(() => {
          if (store.has(key)) return null;
          store.set(key, 0);
          return 'OK';
        });
        return chain;
      },
      incr: (key: string) => {
        ops.push(() => {
          const next = (store.get(key) ?? 0) + 1;
          store.set(key, next);
          return next;
        });
        return chain;
      },
      exec: async () => {
        if (execThrows) throw new Error('redis down');
        const real = ops.map((op) => op());
        return execOverride === false ? real : execOverride;
      },
    };
    return chain;
  });
}

/** The refusal counter's current value on the default registry. */
async function refusals(): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ value: number }> }> }
    | undefined;
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  // A fully empty default registry makes each case order-independent (same choice as the
  // sibling metrics suites).
  client.register.clear();
  setCalls = [];
  store = new Map();
  execOverride = false;
  execThrows = false;
  armSysRedis();
  redisMock.sysRedis.ttl.mockResolvedValue(PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS);
});

describe('checkPrivateRunImpressionRateLimit — instrument validation', () => {
  it('POSITIVE CONTROL: it can REFUSE, and the mock counter really counts', async () => {
    // Without this every `allowed: true` below is indistinguishable from a limiter that can
    // only ever answer allowed — e.g. one whose first line returns it.
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
      allowed: false,
      retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('NEGATIVE CONTROL: a fresh window is allowed', async () => {
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    expect(store.get(KEY)).toBe(1);
  });
});

describe('checkPrivateRunImpressionRateLimit — the key [INV]', () => {
  it('🔴 keys on the VIEWER ALONE — the whole string, so an appended app id fails', async () => {
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(setCalls.map(([key]) => key)).toEqual([KEY]);
    // Stated the other way too, so "let's key on the app as well" has to delete an explicit
    // refusal rather than quietly change a string. `appBlockId` is body-chosen; a per-app
    // bucket bounds nothing.
    expect(setCalls[0][0]).not.toMatch(/apb_/);
  });

  it('🔴 does NOT share the private-run BUZZ CAP bucket', async () => {
    // The nearest neighbour, and the one a reader is most likely to reason by analogy from.
    // It keys on `<viewer>:<appBlockId>` because it is a per-app BUDGET; sharing a prefix
    // would let a review session's spend ceiling and this cost ceiling draw each other down.
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(setCalls[0][0]).not.toContain(REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_BUZZ_CAP);
  });

  it('SEPARATES TWO VIEWERS', async () => {
    await checkPrivateRunImpressionRateLimit(VIEWER);
    await checkPrivateRunImpressionRateLimit(VIEWER + 1);
    expect(new Set(setCalls.map(([key]) => key)).size).toBe(2);
    expect(store.get(KEY)).toBe(1);
  });
});

describe('checkPrivateRunImpressionRateLimit — the window [INV]', () => {
  it('🔴 arms the TTL in the command that CREATES the key, so no TTL-less window exists', async () => {
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(setCalls[0][1], 'the counter starts at 0 and INCR returns 1').toBe('0');
    expect(setCalls[0][2]).toEqual({
      NX: true,
      EX: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('🔴 never issues a self-heal EXPIRE — deliberately unlike the non-atomic sibling', async () => {
    // `block-catalog-rate-limit.ts` re-asserts a lost TTL because its INCR-then-EXPIRE is
    // not atomic. This shape cannot strand a TTL-less key, so a self-heal would be a second
    // round-trip per call on the path this limiter exists to make cheaper. If this goes red,
    // someone has copied the sibling's body over a bucket that does not need it.
    for (let i = 0; i < 3; i++) await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(redisMock.sysRedis.expire).not.toHaveBeenCalled();
  });

  it('allows up to the ceiling and refuses past it — driven through a real counter', async () => {
    // Fixture OVERSHOOTS the boundary rather than landing on it, so the refusal branch is
    // entered several times rather than exactly once at the edge.
    const results: boolean[] = [];
    for (let i = 0; i < PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX + 3; i++) {
      results.push((await checkPrivateRunImpressionRateLimit(VIEWER)).allowed);
    }
    const allowedCount = results.filter(Boolean).length;
    expect(allowedCount, 'exactly the ceiling many calls are allowed').toBe(
      PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX
    );
    // The boundary, both sides, by index — an off-by-one is then a specific failure rather
    // than a count that is merely wrong.
    expect(results[PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX - 1], 'the 30th call is allowed').toBe(
      true
    );
    expect(results[PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX], 'the 31st call is refused').toBe(false);
    expect(results[PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX + 2], 'and so is the 33rd').toBe(false);
  });

  it('the ceiling and window are the SHIPPED numbers', async () => {
    // A cost bound whose arithmetic is quoted in three docblocks and in the flag's
    // precondition ledger. Moving either number silently invalidates all of them.
    expect(PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX).toBe(30);
    expect(PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });
});

describe('checkPrivateRunImpressionRateLimit — fails OPEN [INV]', () => {
  it('a Redis THROW proceeds (and does not count as a refusal)', async () => {
    execThrows = true;
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    // 🔴 The counter must stay clean: it grades a CEILING BITING, and a Redis incident is
    // the opposite reading — the bound is absent, nothing was refused.
    expect(await refusals()).toBe(0);
  });

  it('🔴 a BAD ANSWER proceeds — the guard a `catch` cannot provide', async () => {
    // `undefined <= 30` is FALSE, so with the `typeof`/isFinite guard removed each of these
    // falls through to the refusal branch and the limiter fails CLOSED — against every
    // docblock here and at the call site. Measured that way on a mutant, both arms.
    for (const reply of [
      ['OK', undefined],
      ['OK', null],
      ['OK', Number.NaN],
      ['OK', 'nope'],
      null,
      undefined,
    ]) {
      execOverride = reply as unknown[] | null | undefined;
      expect(
        await checkPrivateRunImpressionRateLimit(VIEWER),
        `reply ${JSON.stringify(reply)} must fail OPEN`
      ).toEqual({ allowed: true });
    }
    expect(await refusals(), 'a malformed reply is not a refusal').toBe(0);
  });
});

describe('checkPrivateRunImpressionRateLimit — retryAfterSeconds [INV]', () => {
  beforeEach(() => {
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
  });

  it('reports the LIVE remaining window', async () => {
    redisMock.sysRedis.ttl.mockResolvedValue(17);
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
      allowed: false,
      retryAfterSeconds: 17,
    });
  });

  it('falls back to the FULL window when the TTL is unset or unreadable', async () => {
    // -1 (no TTL), -2 (no key) and a rejecting TTL read must all back off sanely rather
    // than invite an immediate retry.
    for (const ttl of [-1, -2, 0]) {
      redisMock.sysRedis.ttl.mockResolvedValue(ttl);
      store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
      expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
        allowed: false,
        retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
      });
    }
    redisMock.sysRedis.ttl.mockRejectedValue(new Error('ttl read failed'));
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
      allowed: false,
      retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    });
  });
});

describe(METRIC, () => {
  it('is a REAL scrapeable series, registered by the emit itself', async () => {
    // The emitter is `try {} catch {}` by design, so a name or registration defect produces
    // a silent ZERO — and zero is also the healthy steady state (and the state while the
    // flag is off), so the two are indistinguishable from outside. Hence a real-registry
    // read rather than a mocked call count.
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
    expect(await refusals()).toBe(1);
  });

  it('increments EXACTLY ONCE per refusal', async () => {
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    await checkPrivateRunImpressionRateLimit(VIEWER);
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(await refusals()).toBe(2);
  });

  it('NEGATIVE CONTROL: an allowed call emits NOTHING', async () => {
    // Without this, the assertions above are satisfied by an emitter that fires on every
    // call — which would make the series a traffic counter and useless as an alarm.
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(await refusals()).toBe(0);
  });

  it('carries NO labels — no viewer id can reach prom', async () => {
    // prom-client retains every distinct label set in the Node heap for the process
    // lifetime, and the only candidate label here is identifying. Read the series' own
    // label set rather than trusting the emit call.
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    await checkPrivateRunImpressionRateLimit(VIEWER);
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values).toHaveLength(1);
    expect(Object.keys(values[0].labels)).toEqual([]);
    expect(JSON.stringify(values[0].labels)).not.toContain(String(VIEWER));
  });
});
