import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PrivateRunAccessModule from '../private-run-access.service';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 DOES A PRIVATE-RUN MOUNT STOP PRODUCING AN OWNER-VISIBLE IMPRESSION — AND DOES AN
 * ORDINARY VIEWER'S MOUNT STILL PRODUCE ONE?
 *
 * Both, in pairs, because the two failure directions are not symmetric in cost:
 *   · UNDER-filtering leaks review activity into the owner's `views.count` and, per
 *     `userId`, into `views.uniqueViewers`. That is the bug; it is at least visible.
 *   · OVER-filtering silently deletes the owner's REAL impressions. Worse — nobody
 *     reports numbers they never saw, and `blockRenders` has no status column, so a
 *     dropped row leaves no trace anywhere.
 * So every suppression case here is paired with a case that must NOT be suppressed, and
 * the un-suppressed half is the positive control without which the suppression is
 * indistinguishable from a gate wired to `true`.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT TEST ────────────────────────────────
 * That the WRITERS call this gate, and that they agree. A structural claim plus a
 * behavioural one, both in
 * `src/tests/api/track/block-render.private-run.test.ts` and
 * `block-render-writer.call-site-ledger.test.ts`. This file is the decision only.
 *
 * ── THE COST CLAIMS ARE ASSERTIONS HERE, NOT PROSE ───────────────────────────
 * The gate sits on a high-volume fire-and-forget beacon, so its ordering is a design
 * property rather than a detail: each cheap gate must SHORT-CIRCUIT the expensive ones.
 * Three cases below assert that by counting calls to the mocks that come after them —
 * an ordering regression is then a red test, not a latency mystery.
 *
 * ── THE COST CEILING (GATE 3.5) IS EXERCISED FOR REAL, NOT MOCKED ────────────
 * 🔴 `~/server/utils/private-run-impression-rate-limit` is NOT stubbed here. Only its leaf
 * is: `sysRedis` is the canonical shared mock, driven by a small in-memory keyspace that
 * really honours `SET … NX EX` + `INCR`. That is what makes the anti-rotation case below a
 * BEHAVIOURAL claim (two app ids, one bucket) rather than an assertion about a key string,
 * and it is the property a future "let's key on the app too" edit would silently destroy
 * with nothing else in the repo noticing.
 *
 * ⚠️ AND THE FAIL-OPEN MAKES THAT EASY TO GET WRONG IN THE REASSURING DIRECTION: an UNARMED
 * `sysRedis.multi` throws inside the limiter, which returns `allowed` — so every case here
 * would still pass with the limiter effectively absent. `armed()` arms it, and the
 * instrument-validation case below asserts it was actually CONSULTED.
 */

const { mockKnown, mockFlag, mockAccess } = vi.hoisted(() => ({
  mockKnown: { isConfirmedNonApprovedAppBlockId: vi.fn() },
  mockFlag: { isAppBlocksPrivateRunEnabled: vi.fn() },
  mockAccess: { resolvePrivateRunAccess: vi.fn() },
}));

vi.mock('~/server/services/blocks/known-app-blocks.service', () => mockKnown);
vi.mock('~/server/services/app-blocks-flag', () => mockFlag);
// `importOriginal` so the REAL `PRIVATE_RUN_REFUSAL_REASONS` tuple is still exported —
// the sweep below derives its rows from it rather than from a hand-copied list.
vi.mock('~/server/services/blocks/private-run-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivateRunAccessModule>()),
  resolvePrivateRunAccess: mockAccess.resolvePrivateRunAccess,
}));

// The CANONICAL logging + redis mocks — `~/server/logging/client` and
// `~/server/redis/client` both have one, so a per-file registration of either is a
// `no-direct-shared-module-mock` failure. Using the shared redis mock also means the
// limiter's key is built from the REAL production constant.
import client from 'prom-client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX,
  PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
} from '~/server/utils/private-run-impression-rate-limit';
import { PRIVATE_RUN_REFUSAL_REASONS } from '../private-run-access.service';
import { isPrivateRunImpression } from '../private-run-impression.service';

/** A delisted app's id. Distinct from every other constant so a mutant cannot coincide. */
const DELISTED_APP = 'apb_delisted_fixture';
/** A live, approved app's id. */
const APPROVED_APP = 'apb_approved_fixture';

const OWNER = { id: 8801, isModerator: false } as unknown as SessionUser;
const MODERATOR = { id: 8802, isModerator: true } as unknown as SessionUser;
const STRANGER = { id: 8803, isModerator: false } as unknown as SessionUser;

/** The grant shape the gate reads. Only `allowed` is load-bearing to it. */
function grant(audience: 'owner' | 'editor' | 'moderator') {
  return { allowed: true, audience, block: { appBlockId: DELISTED_APP } };
}
function refuse(reason: (typeof PRIVATE_RUN_REFUSAL_REASONS)[number]) {
  return { allowed: false, reason };
}

/**
 * The cost ceiling's fake keyspace. One `Map` per test, so a window never leaks between
 * cases — with `isolate: false` the redis mock's nodes are worker-scoped, so the
 * implementation has to be re-armed (and the store re-created) per test rather than once.
 */
let rateStore: Map<string, number>;

/** Every key the limiter's MULTI touched, in order. The rotation claim reads this. */
let rateKeys: string[];

/** When true the limiter's `exec` throws; when set, it returns this reply instead. */
let rateExecThrows = false;
let rateExecOverride: unknown[] | false = false;

/**
 * Arm `sysRedis` with a faithful-enough `MULTI: SET k 0 NX EX w` + `INCR k`. Faithful
 * matters: a fixed reply cannot see the boundary, and cannot see whether two app ids share
 * a bucket.
 */
function armRateLimiter() {
  rateStore = new Map();
  rateKeys = [];
  rateExecThrows = false;
  rateExecOverride = false;
  redisMock.sysRedis.ttl.mockResolvedValue(PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS);
  redisMock.sysRedis.multi.mockImplementation(() => {
    const ops: Array<() => unknown> = [];
    const chain: Record<string, unknown> = {
      set: (key: string) => {
        rateKeys.push(key);
        ops.push(() => {
          if (rateStore.has(key)) return null;
          rateStore.set(key, 0);
          return 'OK';
        });
        return chain;
      },
      incr: (key: string) => {
        ops.push(() => {
          const next = (rateStore.get(key) ?? 0) + 1;
          rateStore.set(key, next);
          return next;
        });
        return chain;
      },
      exec: async () => {
        if (rateExecThrows) throw new Error('sysRedis down');
        const real = ops.map((op) => op());
        return rateExecOverride === false ? real : rateExecOverride;
      },
    };
    return chain;
  });
}

/** Total of the gate's rate-limit refusal counter across every label set (there are none). */
async function rateRefusals(): Promise<number> {
  const metric = client.register.getSingleMetric(
    'civitai_app_block_private_run_impression_rate_limit_refusals_total'
  ) as { get(): Promise<{ values: Array<{ value: number }> }> } | undefined;
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** The default world: a signed-in viewer, a non-approved app, the flag on, room in the window. */
function armed() {
  mockKnown.isConfirmedNonApprovedAppBlockId.mockResolvedValue(true);
  mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(true);
  armRateLimiter();
}

/**
 * Push this viewer's window to the ceiling, so the NEXT reaching call is refused. The key is
 * built from the REAL production constant rather than hand-typed — a hand-typed copy is the
 * drift `no-hand-typed-redis-key-constants` exists to stop, and here it would silently make
 * every case below arm a bucket the limiter never reads.
 */
function exhaustWindow(viewer: SessionUser) {
  rateStore.set(
    `${REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_IMPRESSION_RATE_LIMIT}:${viewer.id}`,
    PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX
  );
}

describe('isPrivateRunImpression — instrument validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSITIVE CONTROL: the gate can return TRUE, and it reaches the predicate to do it', async () => {
    // Without this, every `toBe(false)` below is indistinguishable from a gate that can
    // only ever answer false — e.g. one whose first line is `return false`.
    armed();
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL: with the same world, a refusal answers FALSE', async () => {
    // The pair for the above: the gate reads the predicate's ANSWER rather than the fact
    // that it was asked.
    armed();
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(refuse('no-role'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: STRANGER })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });
});

describe('isPrivateRunImpression — a private run is not an impression [REG]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  // ⚠️ A SWEEP, NOT COMPLETENESS — same caveat as the refusal-reason loop below. The gate
  // reads `access.allowed === true` and never looks at `audience`, so these are three
  // copies of one assertion and no "add an audience" mutation can turn them red.
  for (const audience of ['owner', 'editor', 'moderator'] as const) {
    it(`suppresses the impression for the ${audience} audience`, async () => {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant(audience));
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(true);
    });
  }

  it('threads the SERVER-RESOLVED viewer and the resolved flag into the predicate', async () => {
    // 🔴 THE ARGUMENTS, NOT JUST THE CALL. A structural ledger type-checks past a wrong
    // argument: passing the flag as a hardcoded `true`, or a slug where an appBlockId
    // belongs, or `undefined` for the viewer, would all still "call the predicate".
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER });

    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledWith({
      by: { appBlockId: DELISTED_APP },
      viewer: OWNER,
      db: 'read',
      privateRunEnabled: true,
    });
    // And the flag is evaluated FOR THIS VIEWER — a global eval would return the flag's
    // BASE value, which is a measured property of this repo's Flipt client and would
    // make the gate answer for the wrong subject.
    expect(mockFlag.isAppBlocksPrivateRunEnabled).toHaveBeenCalledWith({ user: OWNER });
  });
});

describe('isPrivateRunImpression — an ordinary impression survives [INV]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  it('EVERY refusal reason records the impression, swept over the real tuple', async () => {
    // A refusal means "this mount is not a private run", so the row is real.
    //
    // ⚠️ THIS IS A SWEEP, NOT A COMPLETENESS GUARD, AND THE DIFFERENCE IS WORTH THE LINE.
    // The gate reads `access.allowed === true` — ONE branch for every reason — so adding a
    // tenth member to the tuple adds one more PASSING iteration and NO mutation of "add a
    // reason" can turn this red. Kept because sweeping the real tuple costs nothing and
    // documents the polarity; do not describe it as completeness coverage.
    //
    // The line below IS a working control, and it is the reason the tuple is imported at
    // all: if the `importOriginal` spread ever produced a mocked or empty module, `.length`
    // is `undefined`/`0` and this goes red BEFORE the loop can pass vacuously.
    expect(PRIVATE_RUN_REFUSAL_REASONS.length).toBeGreaterThan(5);
    for (const reason of PRIVATE_RUN_REFUSAL_REASONS) {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(refuse(reason));
      expect(
        await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: STRANGER }),
        `refusal \`${reason}\` must still record the impression`
      ).toBe(false);
    }
  });

  it('records an ANONYMOUS viewer, and pays nothing to decide it', async () => {
    // Signed-out viewers are the bulk of public impressions and can never privately run.
    // The call counts are the cost claim: gate 1 is free.
    for (const viewer of [undefined, null]) {
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer })).toBe(false);
    }
    expect(mockKnown.isConfirmedNonApprovedAppBlockId).not.toHaveBeenCalled();
    expect(mockFlag.isAppBlocksPrivateRunEnabled).not.toHaveBeenCalled();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
    // AND NOT THE COST CEILING EITHER. Gate 1 is free, and "free" has to include the Redis
    // round-trip: anonymous viewers are the bulk of impressions, so a limiter reached here
    // would put a `sysRedis` call on the majority of a high-volume beacon's traffic. Added
    // to the EXISTING case rather than as a new one on purpose — a new case beside an
    // unchanged one leaves a limiter hoisted to the top of the function fully green.
    expect(redisMock.sysRedis.multi).not.toHaveBeenCalled();
  });

  it('records a session carrying no numeric id', async () => {
    const malformed = { id: undefined } as unknown as SessionUser;
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: malformed })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('🔴 records an APPROVED app without evaluating the flag or the predicate', async () => {
    // The over-filtering bound, and the cost claim, in one case: a publicly mountable app
    // can never be hidden, and the common beacon path stops at a cached set lookup.
    mockKnown.isConfirmedNonApprovedAppBlockId.mockResolvedValue(false);
    // Armed to SUPPRESS if it got that far — so this case fails loudly if the
    // short-circuit is removed rather than passing for the wrong reason.
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));

    expect(await isPrivateRunImpression({ appBlockId: APPROVED_APP, viewer: OWNER })).toBe(false);
    expect(mockFlag.isAppBlocksPrivateRunEnabled).not.toHaveBeenCalled();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
    // …and the cost ceiling is not consulted either: an approved app can never be a private
    // run, so charging its mounts against a viewer's window would spend the allowance on the
    // public path AND put a Redis call on it.
    expect(redisMock.sysRedis.multi).not.toHaveBeenCalled();
  });

  it('🔴 records everything while the FLAG IS OFF, and touches no database', async () => {
    // The kill-switch is a complete rollback: flag off restores the pre-feature
    // behaviour exactly, and costs no query to do it.
    mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(false);
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
    // AND THE CHEAP GATE RAN FIRST — the ordering from this side. (The approved-app case
    // above pins the same order from the other: step 2 returning false means the flag must
    // not have been consulted. Either alone would do; both make the direction obvious.)
    expect(mockKnown.isConfirmedNonApprovedAppBlockId).toHaveBeenCalled();
    // 🔴 AND THE CEILING SITS BEHIND THE FLAG, WHICH IS THE WHOLE COST ARGUMENT FOR ITS
    // POSITION: with the flag off — production today — it costs ZERO Redis calls. If this
    // goes red, gate 3.5 has moved above gate 3 and the limiter is now on every signed-in
    // beacon for a non-approved app whether or not the feature is enabled at all.
    expect(redisMock.sysRedis.multi).not.toHaveBeenCalled();
  });
});

describe('isPrivateRunImpression — failures fail TOWARD recording [INV]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  it('records the impression when the predicate THROWS — and SAYS SO', async () => {
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(new Error('replica unreachable'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    // 🔴 A gate that fails open without a trace means the leak is reopened and nothing
    // says so. The log is what makes the fail-open observable rather than reassuring.
    // The COUNT is asserted beside it so `toHaveBeenCalledWith` — which matches ANY call —
    // cannot be satisfied while a second, unreviewed log line rides along.
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'private-run-impression-gate-failed', type: 'error' }),
      'clickhouse'
    );
  });

  it('NEGATIVE CONTROL: a clean decision logs NOTHING', async () => {
    // Without this, the assertion above is satisfied by a gate that logs on every call —
    // which would flood the beacon path and make the signal worthless.
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('🔴 the fail-open log carries the error CLASS, never the error MESSAGE', async () => {
    // The identifiers belong in the mint's audit line. This is a health signal, and a
    // per-impression health signal that carries identifiers is a second, unreviewed audit
    // trail on a public write path.
    //
    // 🔴 THE MESSAGE IS THE LEAK VECTOR, AND A "no user id" SWEEP DOES NOT CATCH IT. A
    // `PrismaClientValidationError` renders the failing invocation INCLUDING ITS ARGUMENTS
    // — the call inside the try being `user.findUnique({ where: { id: <viewer.id> } })`.
    // A fixture whose error text happens to be clean (`'boom'`) sweeps green over exactly
    // that defect, so this plants an identifier IN THE MESSAGE and asserts the shape.
    //
    // 🔴 AND IT ASSERTS OVER *EVERY* CALL, WITH A COUNT — "no bad one exists", not "a good
    // one exists". Reading `calls[0]` alone is walked by a SECOND `logToAxiom` appended in
    // the same catch: the first payload still looks right, `gateFailedOpen()` is still
    // true, and the message ships anyway. That is the same class this file's viewer-
    // threading sibling was rewritten to close.
    const secret = `prisma-arg-${MODERATOR.id}-${DELISTED_APP}`;
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(new TypeError(secret));
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR });

    expect(loggingMock.logToAxiom, 'the catch logs exactly once').toHaveBeenCalledTimes(1);
    const calls = loggingMock.logToAxiom.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls[0][0].errorClass, 'the class is what a health signal needs').toBe('TypeError');
    for (const [payload] of calls) {
      const serialised = JSON.stringify(payload);
      expect(serialised, 'no message text may reach the log').not.toContain(secret);
      expect(serialised).not.toContain(DELISTED_APP);
      expect(serialised).not.toContain(String(MODERATOR.id));
    }
  });

  it('🔴 records the impression when the LOG ITSELF throws', async () => {
    // The gate's own observability call is the only leaf no other case drives, and
    // `block-render.ts` awaits the gate with no try/catch — so "it swallows everything
    // internally" needs to be a measurement rather than a premise.
    loggingMock.logToAxiom.mockImplementationOnce(() => {
      throw new Error('axiom client exploded');
    });
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(new Error('replica unreachable'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    // REACHED the leaf — without this, a gate that short-circuited before logging would
    // pass this case while measuring nothing.
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('🔴 records the impression when the LOG REJECTS — and HANDLES the rejection', async () => {
    // 🔴 `resolves.toBe(false)` ALONE CANNOT SEE THE `.catch`, and neither can an
    // `unhandledRejection` listener — MEASURED: with the `.catch` deleted, every test
    // still passed and the test COUNT did not move, so both the per-test result lines and
    // the count-moved check read green. A dangling rejection is invisible to a harness
    // built on either.
    //
    // So the property is observed DIRECTLY: the gate must ATTACH a rejection handler to
    // whatever the logger returns. A thenable whose `.catch` is a spy turns "is it
    // handled?" into a call count. `packages/civitai-axiom` records the cost of getting
    // this wrong — an unhandled rejection from a non-awaited log call exited three pods
    // at once.
    const attachCatch = vi.fn(() => Promise.resolve(undefined));
    loggingMock.logToAxiom.mockReturnValueOnce({ catch: attachCatch } as unknown as Promise<void>);
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(new Error('replica unreachable'));

    await expect(
      isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })
    ).resolves.toBe(false);
    expect(
      attachCatch,
      'the gate must attach a rejection handler to the log promise'
    ).toHaveBeenCalledTimes(1);
  });

  it('a NON-Error throw is classified by `typeof`, and still leaks nothing', async () => {
    // Covers the `typeof err` branch, which every other case leaves unexercised — and a
    // thrown string is the shape most likely to carry text straight into a payload.
    const secret = `raw-throw-${MODERATOR.id}`;
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(secret);
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );

    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    const [payload] = loggingMock.logToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(payload.errorClass).toBe('string');
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it('records the impression when the FLAG CLIENT throws', async () => {
    mockFlag.isAppBlocksPrivateRunEnabled.mockRejectedValue(new Error('flipt down'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('records the impression when the APPROVED-SET lookup throws', async () => {
    mockKnown.isConfirmedNonApprovedAppBlockId.mockRejectedValue(new Error('db down'));
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(false);
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('🔴 the COST CEILING is TOTAL — a synchronous `multi()` throw never reaches the gate', async () => {
    // The limiter must not be able to turn a Redis fault into a gate failure: `block-render.ts`
    // awaits this gate with no try/catch of its own, and the gate's own catch would RECORD the
    // impression — i.e. a Redis blip would start leaking review activity into owners' panels.
    // So the decision here must be the PREDICATE's (suppress), not the catch's (record).
    //
    // 🔴 THE LOG ASSERTION IS BY NAME, AND IT USED TO BE `not.toHaveBeenCalled()` ON THE
    // WHOLE MOCK. That form conflated two different claims — "the GATE did not fail" and
    // "nothing was logged at all" — so it blocked instrumenting the limiter's own fail-open
    // while asserting nothing extra about the gate. Both halves are asserted separately
    // now: the gate's error line must be ABSENT, and the limiter's fail-open line must be
    // PRESENT, because a Redis fault that logs nothing anywhere is the reassuring-zero
    // shape this feature keeps regenerating.
    redisMock.sysRedis.multi.mockImplementation(() => {
      throw new Error('multi threw synchronously');
    });
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(
      mockAccess.resolvePrivateRunAccess,
      'gate 4 must still be reached'
    ).toHaveBeenCalledTimes(1);
    const logged = (loggingMock.logToAxiom.mock.calls as Array<[Record<string, unknown>]>).map(
      ([payload]) => payload?.name
    );
    expect(logged, 'this is not a gate failure').not.toContain(
      'private-run-impression-gate-failed'
    );
    expect(logged, 'but a Redis fault must not be silent either').toEqual(['sysredis-fail-open']);
  });

  it('records the impression when the predicate answers a SHAPE it should not', async () => {
    // `allowed === true` is required, not `allowed` truthiness — a future refactor that
    // returns a string, or omits the field, must not be read as a grant.
    for (const weird of [{}, { allowed: 'yes' }, { allowed: 1 }, undefined]) {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(weird);
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(false);
    }
  });
});

/**
 * GATE 3.5 — THE PER-VIEWER COST CEILING.
 *
 * 🔴 WHAT IT BOUNDS, AND WHY THAT IS NOT AN AUTHORIZATION CLAIM. `appBlockId` comes out of
 * the request body, so before this ceiling a signed-in caller could drive gate 4's 4–9
 * single-row queries — one on the WRITE PRIMARY — at whatever rate they liked, on a public
 * beacon whose common path used to do ZERO Postgres queries.
 *
 * 🔴 EVERY CASE HERE ASSERTS BOTH HALVES, because either alone is satisfiable by a defect:
 * the ANSWER (`false` ⇒ the impression is recorded) and the COST (`resolvePrivateRunAccess`
 * call count). A refusal that returned `true` would be a client-triggerable suppression —
 * a larger defect than the leak — and a refusal that still ran the predicate would bound
 * nothing at all.
 *
 * 🔴 THE LABEL IS PER TEST, NOT PER DESCRIBE, and the split is MEASURED rather than assumed.
 * Applying this repo's mechanical definition — would it go RED against pre-change behaviour?
 * — by deleting gate 3.5 from `private-run-impression.service.ts`: **5 of these 9 went red,
 * 4 stayed green**. The four are controls and fail-open invariants, which is exactly what
 * they should be: at base there is no limiter, so "the predicate is still reached" is
 * trivially true there. Labelling all nine `[REG]` would be the mistake the sibling
 * `src/tests/api/track/block-render.private-run.test.ts` records having made and corrected.
 *
 * ⚠️ AND THE THREE CHEAP-PATH ASSERTIONS ADDED ABOVE (anonymous / approved app / flag off)
 * are `[INV]` for the same reason — they cannot go red at base either. Their mutant is a
 * DIFFERENT one, and it was run: hoisting gate 3.5 above gate 1 turns all three red, and
 * hoisting it above gate 2 turns the approved-app and flag-off pair red. That is the defect
 * they exist for — a limiter on the cheap path, i.e. a `sysRedis` round-trip on the majority
 * of a high-volume public beacon's traffic.
 */
describe('isPrivateRunImpression — the cost ceiling on gate 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));
  });

  it('[REG] INSTRUMENT: the ceiling is really CONSULTED on a reaching call', async () => {
    // Without this every case below is satisfiable by an unarmed limiter that fails open,
    // which is exactly what a bare `sysRedis` hybrid node does (`multi()` → undefined →
    // TypeError → the limiter's own catch → `allowed`). Prove it is wired before reading a
    // verdict from it.
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR });
    expect(redisMock.sysRedis.multi).toHaveBeenCalledTimes(1);
    expect(rateKeys, 'one bucket, keyed on the viewer').toEqual([
      `${REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_IMPRESSION_RATE_LIMIT}:${MODERATOR.id}`,
    ]);
  });

  it('[REG] 🔴 OVER THE CEILING: the impression is RECORDED and the predicate is never asked', async () => {
    exhaustWindow(MODERATOR);
    // The world is armed to SUPPRESS, so this case fails loudly if the refusal accidentally
    // reaches gate 4 rather than passing for the wrong reason.
    expect(
      await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR }),
      'a refusal must RECORD, never suppress — a suppression a caller can trigger is worse than the leak'
    ).toBe(false);
    expect(
      mockAccess.resolvePrivateRunAccess,
      'the expensive gate must not run at all — that is the whole point'
    ).toHaveBeenCalledTimes(0);
  });

  it('[INV] NEGATIVE CONTROL: under the ceiling the predicate IS reached and a grant still suppresses', async () => {
    // The pair for the case above. Without it, that one passes just as happily against a
    // predicate that is never reached under any circumstances.
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });

  it('[REG] 🔴 ANTI-ROTATION: two different app ids share ONE bucket', async () => {
    // THE PROPERTY A KEY-STRING ASSERTION CANNOT SEE, and the one a future "let's key on the
    // app too" edit would silently destroy with nothing else in the repo noticing. `appBlockId`
    // is body-chosen, so a viewer+app key hands out a fresh window per invented id and the
    // ceiling bounds nothing. Driven behaviourally: alternate two ids past the ceiling and
    // require a refusal. With the app in the key each bucket would hold ~half the calls and
    // NOTHING would ever be refused.
    const answers: boolean[] = [];
    for (let i = 0; i < PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX + 1; i++) {
      answers.push(
        await isPrivateRunImpression({
          appBlockId: i % 2 === 0 ? DELISTED_APP : `${DELISTED_APP}_rotated_${i}`,
          viewer: MODERATOR,
        })
      );
    }
    // Armed to suppress, so `true` = reached gate 4 and was granted, `false` = refused by the
    // ceiling (this world has no other route to `false`).
    expect(answers.filter((a) => a === true).length, 'exactly the ceiling many got through').toBe(
      PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX
    );
    expect(
      answers[PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX],
      'the call past the ceiling is refused'
    ).toBe(false);
    expect(
      mockAccess.resolvePrivateRunAccess,
      'and the predicate ran only for the calls inside the window'
    ).toHaveBeenCalledTimes(PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX);
    expect(new Set(rateKeys).size, 'every app id charged the SAME bucket').toBe(1);
  });

  it('[INV] 🔴 FAILS OPEN on a Redis error: the expensive gate still runs, the decision is unchanged', async () => {
    // The inversion worth naming: for an ordinary limiter fail-open means "serve"; here it
    // means "pay for the queries". A Redis incident therefore removes the COST BOUND, not the
    // protection — deliberate, because the alternative is a cache blip reopening the leak.
    rateExecThrows = true;
    // A DELTA, not an absolute: the default prom registry is process-wide and earlier cases
    // in this file legitimately leave counts on it.
    const before = await rateRefusals();
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
    expect(await rateRefusals(), 'a Redis fault is not a refusal').toBe(before);
    // 🔴 AND IT IS NOT SILENT. The counter staying flat is correct and is exactly why the
    // incident needs its own signal: with both quiet, a sustained fault — the window in
    // which the cost bound does not exist — reads as health on everything this path emits.
    expect(
      (loggingMock.logToAxiom.mock.calls as Array<[Record<string, unknown>]>).map(
        ([payload]) => [payload?.name, payload?.subtype] as const
      ),
      'the absent cost bound must be observable'
    ).toEqual([['sysredis-fail-open', 'rate-limit-write-degraded']]);
  });

  it('[INV] 🔴 FAILS OPEN on a BAD ANSWER too — a `catch` guards throws, not answers', async () => {
    // `undefined <= 30` is FALSE, so without the limiter's `typeof`/isFinite guard this
    // resolves to a REFUSAL and the gate stops asking the predicate — i.e. it fails CLOSED
    // against every docblock. Both arms measured; the limiter's own suite holds the mutant.
    rateExecOverride = ['OK', undefined];
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });

  it('[REG] 🔴 a refusal EMITS THE COUNTER exactly once', async () => {
    // A refusal here has a CORRECTNESS consequence — the impression is recorded, so it
    // reaches the app owner — and a silent one is the reassuring-zero shape. Read as a DELTA
    // against the real registry, so it cannot be wrong about a label or about registration
    // order.
    const before = await rateRefusals();
    exhaustWindow(MODERATOR);
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR });
    expect(await rateRefusals()).toBe(before + 1);
  });

  it('[INV] NEGATIVE CONTROL: a clean decision emits NOTHING', async () => {
    // Without this the assertion above is satisfied by an emitter that fires on every call,
    // which would make the series a traffic counter and useless as an alarm.
    const before = await rateRefusals();
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR });
    expect(await rateRefusals()).toBe(before);
  });

  it('[REG] each VIEWER gets their own window — one reviewer cannot exhaust another', async () => {
    // The flip side of keying on the viewer: the ceiling is per-person, so a busy moderator
    // cannot cost an app owner their own private runs.
    exhaustWindow(MODERATOR);
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(true);
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });
});
