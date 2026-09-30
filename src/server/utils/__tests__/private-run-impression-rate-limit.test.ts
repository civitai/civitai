import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
 * Nine contracts, and the first two are the ones no sibling limiter has:
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
 *   (e) 🔴 fail-open on a HANG. A `catch` guards against a throw and the leaf's real
 *       failure mode is a park, so this is the arm the other four could not see: the MULTI
 *       is raced against the sys read deadline and a never-settling `exec` must still
 *       answer `allowed`. Two arms, one of them a positive control — see that describe.
 *   (f) 🔴 and the fail-open SAYS SO. Every fail-open arm emits `sysredis-fail-open` /
 *       `rate-limit-write-degraded`; a refusal and a clean call emit nothing. Without it a
 *       sustained incident reads as health on every other signal here.
 *   (g) `retryAfterSeconds` is the window CONSTANT — asserted with the TTL mock armed to a
 *       value the constant cannot equal, and with `ttl` asserted NEVER called.
 *   (h) the refusal counter — a real prom-registry read, because a refusal here has a
 *       CORRECTNESS consequence (the impression gets recorded, so it reaches the owner)
 *       and a silent refusal is the reassuring-zero shape.
 *   (i) 🔴 and the fail-open log CANNOT THROW OUT of the limiter. (f) added a synchronous
 *       `safeError` call inside the `catch`, which made this body non-total again — so (i)
 *       exists because (f) shipped, and the two must be read together rather than as one
 *       "observability" contract.
 *
 * ⚠️ LABEL THIS FILE HONESTLY, AND THE LABEL IS NOW MIXED. Contracts (a)–(d), (g) and (h)
 * are NOT regression coverage: the limiter did not exist on the pre-change tree, so nothing
 * there could be watched failing against a build that had the defect. The red-then-green
 * matrix for that BEHAVIOUR lives in `blocks/__tests__/private-run-impression.service.test.ts`,
 * driven through the gate, whose cases were each watched red with gate 3.5 removed.
 * Contracts (e), (f) and (i) ARE regression coverage — marked `[REG]`. (e) and (f) were
 * watched red on this branch's PREVIOUS head, where the limiter shipped with an unwrapped
 * await and a bare `catch {}`. (i) was watched red on head `201d858cd7` — i.e. on the
 * commit that added (f) — and green at `47a5fcdea7`, which is the honest reading: the
 * instrumentation in (f) is what introduced the defect (i) pins.
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
/** When true, `exec` returns a promise that NEVER settles — the silent half-open shape. */
let execHangs = false;
/**
 * When set, `sysRedis.multi()` THROWS `.value` — boxed so a thrown `undefined`/`null` is
 * still distinguishable from "not arming this at all". Exists to reach the `catch` arm
 * with a NON-Error value, which is the only way to drive the logger's own throw.
 */
let multiThrows: { value: unknown } | null = null;

/**
 * A faithful-enough `MULTI: SET k 0 NX EX w` + `INCR k`: the `SET` creates the key at 0
 * only when absent (and reports `null` when it did nothing, like a real NX miss), and the
 * `INCR` returns the post-increment value. Faithful enough matters — a mock that always
 * returns a fixed count cannot see the boundary or the rotation property.
 */
function armSysRedis() {
  redisMock.sysRedis.multi.mockImplementation(() => {
    if (multiThrows) throw multiThrows.value;
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
        // A HANG, not a throw. This is what a silent half-open produces: the command is
        // written, nothing ever answers, and no `catch` anywhere can see it.
        if (execHangs) return new Promise(() => {});
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
  execHangs = false;
  multiThrows = null;
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

describe('checkPrivateRunImpressionRateLimit — a sysRedis HANG [REG]', () => {
  /**
   * 🔴 THE DEFECT THIS PAIR PINS: a `catch` guards against a THROW, and the failure mode
   * this limiter's leaf actually has is a HANG. The sys client carries no socketTimeout
   * (`REDIS_SYS_SOCKET_TIMEOUT_MS` defaults to 0) and a per-command timeout does not bound
   * a command once written, so on a silent half-open a written sys command parks until OS
   * TCP keepalive errors the socket. `block-render.ts` awaits this gate unwrapped and with
   * no timeout of its own, so an unbounded await here parks request handlers on a public,
   * high-volume beacon — the opposite of the fail-open this file's docblock promises.
   *
   * TWO ARMS ON PURPOSE. Arm A is the POSITIVE CONTROL: it proves this probe can observe a
   * fail-open at all, so arm B settling is a claim about the deadline rather than about a
   * limiter that can only ever answer `allowed`. Watched red-then-green: with the
   * `withSysReadDeadline` wrapper removed, arm A stays GREEN and arm B FAILS on the
   * sentinel — i.e. the pair separates the two mechanisms rather than merely failing.
   *
   * The wrapper here is the REAL one: `~/__tests__/mocks/redis.mock` defaults the
   * `withSysReadDeadline` seam to the real implementation, so this exercises the shipped
   * race and the shipped default (`REDIS_SYS_READ_TIMEOUT_MS`), not a stand-in whose
   * rejection shape could differ from it. That is the whole point — the finding was about
   * assuming a failure mode instead of reading it.
   */
  /** Comfortably past the shipped read deadline; only a genuinely unbounded await hits it. */
  const NEVER_SETTLED_AFTER_MS = 8_000;
  const SENTINEL = 'NEVER SETTLED' as const;

  async function raceAgainstSentinel(): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sentinel = new Promise<typeof SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(SENTINEL), NEVER_SETTLED_AFTER_MS);
    });
    return Promise.race([checkPrivateRunImpressionRateLimit(VIEWER), sentinel]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  it('ARM A — POSITIVE CONTROL: a REJECTING exec settles fail-open well inside the sentinel', async () => {
    execThrows = true;
    expect(await raceAgainstSentinel()).toEqual({ allowed: true });
  });

  it('🔴 ARM B: a NEVER-SETTLING exec still settles fail-open, bounded by the read deadline', async () => {
    execHangs = true;
    expect(
      await raceAgainstSentinel(),
      'an unbounded sysRedis await parks the beacon handler — it must be raced against the sys read deadline'
    ).toEqual({ allowed: true });
    // A hang is a limiter fault, not a ceiling biting: the counter grades refusals.
    expect(await refusals(), 'a hang is not a refusal').toBe(0);
  });

  it('routes the MULTI through the sys read-deadline seam at all', async () => {
    // The structural half. Arm B is the behavioural claim; this one fails loudly if the
    // wrapper is deleted while some other timeout coincidentally settles the await.
    await checkPrivateRunImpressionRateLimit(VIEWER);
    expect(redisMock.withSysReadDeadline).toHaveBeenCalledTimes(1);
  });
});

describe('checkPrivateRunImpressionRateLimit — retryAfterSeconds [INV]', () => {
  beforeEach(() => {
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
  });

  it('🔴 is the WINDOW CONSTANT, and costs NO second Redis round-trip', async () => {
    // It used to be a live `sysRedis.ttl` read. Enumerated dead — the only production
    // consumer reads `.allowed` — and it was worse than merely unused: an extra unbounded
    // sysRedis call on the REFUSAL path (the abuse path), and a SYNCHRONOUS throw from it
    // escaped to the outer catch, converting a decided refusal into an ALLOW with no
    // counter emitted. The TTL mock below is armed to a value the constant cannot equal, so
    // a reintroduced read is a red test rather than a coincidence.
    redisMock.sysRedis.ttl.mockResolvedValue(17);
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
      allowed: false,
      retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    });
    expect(redisMock.sysRedis.ttl, 'the refusal path must not read the TTL').not.toHaveBeenCalled();
  });

  it('is the same constant on EVERY refusal, not only the first', async () => {
    // The window is fixed, so the answer cannot legitimately drift between refusals within
    // one window — and a residual TTL read would make it drift.
    //
    // 🔴 THIS ARMING IS THE POINT, AND WITHOUT IT THE SENTENCE ABOVE WAS A LIE ABOUT THIS
    // TEST. The shared `beforeEach` arms `ttl` to WINDOW_SECONDS — the exact constant
    // asserted below — so a mutant that reads the TTL returns the asserted value BY
    // CONSTRUCTION and this case stays green. Measured: reintroducing the TTL read left
    // this test passing and only its sibling above red. A fixture that can only ever
    // produce the constant's own value cannot see a mutant that returns that constant.
    // So feed a value the constant CANNOT equal, exactly as the sibling does.
    redisMock.sysRedis.ttl.mockResolvedValue(23);
    for (let i = 0; i < 3; i++) {
      store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
      expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
        allowed: false,
        retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
      });
    }
  });
});

describe('checkPrivateRunImpressionRateLimit — the fail-open SAYS SO [REG]', () => {
  /**
   * 🔴 THE DEFECT: the fail-open was a bare `catch {}`, so during a sustained Redis
   * incident — exactly when the cost bound is absent — every signal this limiter emits
   * reads as health. The refusal counter cannot carry it and must not: it grades a ceiling
   * BITING, and the two suites either side of this one assert it stays at zero on a fault.
   *
   * The subtype is `rate-limit-write-degraded`, whose own docblock in `fail-open-log.ts`
   * says a sustained spike means abuse prevention is effectively disabled.
   *
   * ⚠️ AND THIS DOCBLOCK ADDED "and which already has a Loki alert consuming it", WHICH IS
   * FALSE. Measured against the infrastructure repo at its default branch, that subtype
   * appears in exactly one file — a dated handoff note — with no alert rule and no
   * dashboard panel; the positive control on the sibling subtype `tracking-write-cliff`
   * resolves to five files including two alert definitions, so the search can match. The
   * catch-all error-signature detector is doubly blind to it: it excludes the
   * `sysredis-fail-open` name from its regex and selects error-level lines, while this is
   * emitted at `warning`. So these cases assert that the signal is EMITTED. Whether
   * anything CONSUMES it is a separate, currently-OPEN question, tracked as a named
   * residual in the flag's precondition ledger — not something this suite can or does show.
   */
  function failOpenLogs() {
    return (loggingMock.logToAxiom.mock.calls as Array<[Record<string, unknown>]>)
      .map(([payload]) => payload)
      .filter((payload) => payload?.name === 'sysredis-fail-open');
  }

  it('🔴 a THROW emits the fail-open log exactly once', async () => {
    execThrows = true;
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    const logs = failOpenLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].subtype).toBe('rate-limit-write-degraded');
    expect(logs[0].fn).toBe('checkPrivateRunImpressionRateLimit');
  });

  it('🔴 a deadline-bounded HANG emits it too — the arm an incident actually produces', async () => {
    execHangs = true;
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    expect(failOpenLogs().map((l) => l.subtype)).toEqual(['rate-limit-write-degraded']);
  });

  it('🔴 a BAD ANSWER emits it too — a `catch` never runs, so it would stay silent', async () => {
    execOverride = ['OK', undefined];
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    const logs = failOpenLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].fn).toBe('checkPrivateRunImpressionRateLimit: malformed counter reply');
  });

  it('NEGATIVE CONTROL: an allowed call and a REFUSAL both log nothing', async () => {
    // Without this, the three above are satisfied by a logger that fires on every call —
    // which on this beacon would flood the sink and make the signal worthless. The refusal
    // half matters separately: a ceiling biting is the limiter WORKING, not degraded.
    await checkPrivateRunImpressionRateLimit(VIEWER);
    store.set(KEY, PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({
      allowed: false,
      retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    });
    expect(failOpenLogs()).toHaveLength(0);
  });

  it('🔴 carries NO viewer id — same reason the counter carries no labels', async () => {
    execThrows = true;
    await checkPrivateRunImpressionRateLimit(VIEWER);
    for (const payload of failOpenLogs())
      expect(JSON.stringify(payload)).not.toContain(String(VIEWER));
  });
});

describe('checkPrivateRunImpressionRateLimit — the fail-open LOG cannot throw OUT of it [REG]', () => {
  /**
   * 🔴 THE DEFECT THIS PINS: adding the fail-open log made the limiter's body NON-TOTAL
   * again. `logSysRedisFailOpen` calls `safeError(err)` SYNCHRONOUSLY, and that helper's
   * non-Error branch is `String(e)` (`packages/civitai-axiom/src/client.ts`), which THROWS
   * on a value with no `toString` — a null-prototype object, a `Symbol`. A throw raised
   * inside a `catch` block is not caught by that block, so it rejected straight out of
   * `checkPrivateRunImpressionRateLimit`.
   *
   * WHY THAT MATTERS MORE THAN A LOST LOG LINE: the rejection reaches the gate's own
   * `catch` (`blocks/private-run-impression.service.ts`), which answers `false` — "not a
   * private run" — so the impression IS RECORDED. That is exactly the leak this feature
   * exists to close, produced by the observability added to protect it. Fail-open inside
   * the limiter would instead have let the access predicate decide.
   *
   * Watched red-then-green on this branch: red at head `201d858cd7` with
   * `TypeError: Cannot convert object to primitive value`, green at `47a5fcdea7` (where the
   * log did not yet exist) and green once each emit got its own `try {} catch {}`.
   *
   * ⚠️ HONEST SCOPE: only the `catch` arm is reachable this way. The malformed-reply arm
   * passes `err = null`, and `safeError(null)` returns `undefined` before it can stringify
   * anything — its wrap is an invariant guard against a future logger, not a fix for a live
   * escape, and is asserted below as such rather than counted as regression coverage.
   */
  it('🔴 a thrown value with NO `toString` still fails OPEN instead of rejecting', async () => {
    // A null-prototype object is the smallest real instance: `String(x)` on it throws
    // rather than producing "[object Object]".
    multiThrows = { value: Object.create(null) };
    await expect(
      checkPrivateRunImpressionRateLimit(VIEWER),
      'the fail-open logger must not be able to reject the limiter it is observing'
    ).resolves.toEqual({ allowed: true });
    // A logger fault is not a ceiling biting, exactly like every other fail-open arm.
    expect(await refusals(), 'a swallowed logger throw is not a refusal').toBe(0);
  });

  it('POSITIVE CONTROL: an ORDINARY Error still reaches the log', async () => {
    // Without this, the two above are satisfied by a fix that simply stopped logging. The
    // containment must swallow the LOGGER's throw, never the emit itself.
    execThrows = true;
    expect(await checkPrivateRunImpressionRateLimit(VIEWER)).toEqual({ allowed: true });
    const logged = (loggingMock.logToAxiom.mock.calls as Array<[Record<string, unknown>]>)
      .map(([payload]) => payload)
      .filter((payload) => payload?.name === 'sysredis-fail-open');
    expect(logged, 'a stringifiable error must still be reported').toHaveLength(1);
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
