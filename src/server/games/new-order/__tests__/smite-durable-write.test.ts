import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🔴 THE SEAM BETWEEN `smitePlayer` AND ANY CALLER THAT RECORDS WHETHER AN ACCOUNT WAS PENALISED.
 *
 * `smitePlayer` commits the smite ROW — the durable penalty — and then does a tail of non-durable
 * work: an active-smite count, a possible career reset, a Redis counter increment, a signal, a
 * notification. The counter increment is the sharp one: it calls `getCount`, which re-throws a
 * non-connection ClickHouse error, and then writes to `sysRedis` UNGUARDED, so a Redis or ClickHouse
 * blip throws out of `smitePlayer` with the penalty already live in Postgres.
 *
 * A caller that infers "was smited" from the call returning therefore under-counts a real penalty.
 * `onSmiteCreated` exists to carry that fact out regardless, and `new-order-abuse-detection` files
 * its board findings from it — an account it gets wrong reads as an open case beside a live smite,
 * which invites a moderator to apply a second one.
 *
 * This file exercises the REAL `smitePlayer` (only the db, counters, signal and notification are
 * mocked) so the abuse-scan suite's fake — which fires the hook and then throws — is a model of
 * MEASURED behaviour rather than of an assumption. A suite that only ever tests its own fake cannot
 * see the two drift apart.
 */

const {
  smitesCounterStub,
  counterStub,
  mockCreateNotification,
  mockSignalSend,
  mockFetchThroughCache,
  mockHandleLogError,
} = vi.hoisted(() => {
  const stub = () => ({
    increment: vi.fn(),
    decrement: vi.fn(),
    reset: vi.fn(),
    getCount: vi.fn(),
    getCountBatch: vi.fn(),
    getAll: vi.fn(),
    exists: vi.fn(),
    key: 'stub',
  });
  return {
    smitesCounterStub: stub(),
    counterStub: stub(),
    mockCreateNotification: vi.fn(),
    mockSignalSend: vi.fn(),
    mockFetchThroughCache: vi.fn(),
    // 🔴 FAITHFUL TO THE REAL `handleLogError`, WHICH DEREFS `e.message` WITH NO GUARD
    // (`src/server/utils/errorHandling.ts`) — BUT IT IS NOT WHAT MAKES THE NON-`Error` CASES GO RED.
    // `expect.any(Error)` is: measured, with a bare `vi.fn()` here AND the normalisation reverted,
    // those cases still fail, at the argument match (`-  Any<Error>  +  null`). What the faithful
    // mock adds is production-symptom fidelity on the SYNC case — the failure presents as a rejected
    // promise, the way it would in production, instead of an argument mismatch. On the ASYNC case it
    // changes nothing.
    //
    // So do not relax `expect.any(Error)` to `expect.anything()` on the strength of this mock. That
    // is the single edit that makes both cases vacuous, and it is the one a reader who believes the
    // mock is the guard would feel free to make.
    mockHandleLogError: vi.fn((e: Error) => {
      void new Error(e.message ?? 'Unexpected error occurred', { cause: e });
    }),
  };
});

// Heavy transitive deps the service imports at module load — stubbed so importing the real service
// doesn't drag in db/redis/env/otel/signal machinery. Mirrors `sanity-check-buffer.test.ts`.
vi.mock('~/server/games/new-order/utils', () => ({
  acolyteFailedJudgments: counterStub,
  allJudgmentsCounter: counterStub,
  blessedBuzzCounter: counterStub,
  correctJudgmentsCounter: counterStub,
  expCounter: counterStub,
  fervorCounter: counterStub,
  pendingBuzzCounter: counterStub,
  recentlyGrantedBuzzCounter: counterStub,
  sanityCheckFailuresCounter: counterStub,
  smitesCounter: smitesCounterStub,
  poolCounters: {},
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn(),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn(),
  getImageRatingsCounter: vi.fn(),
  getVotingCooldownUntil: vi.fn(),
  getVotingRateLimitConfig: vi.fn(),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: mockHandleLogError,
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: mockFetchThroughCache }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ claimCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: mockSignalSend, topicSend: vi.fn() },
}));

// Import AFTER mocks — the real `smitePlayer` stays in play.
import { smitePlayer } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockCreate = dbMock.dbWrite.newOrderSmite.create;
const mockCount = dbMock.dbWrite.newOrderSmite.count;
/**
 * The cleanse inside `resetPlayer`'s transaction — the observable that the THIRD-STRIKE branch
 * really executed. Asserting only that the hook fired would pass identically on the sub-threshold
 * path, which is what makes the branch case vacuous without it.
 */
const mockCleanseSmites = dbMock.dbWrite.newOrderSmite.updateMany;

const SMITE_ROW = {
  id: 4321,
  targetPlayerId: 7,
  givenById: 1,
  reason: 'r',
  size: 50,
  remaining: 50,
};

// Mirrors the parameter's own type, `unknown`, so the async and non-`Error` cases below are real
// calls rather than ones smuggled past a narrower local alias.
const call = (onSmiteCreated?: (smite: { id: number }) => unknown) =>
  smitePlayer({ playerId: 7, modId: 1, reason: 'r', size: 50, onSmiteCreated });

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(SMITE_ROW);
  // Below the third-strike rule, so the career-reset branch stays out of the way. The branch is NOT
  // left untested by that — the dedicated case below raises this and asserts on it.
  mockCount.mockResolvedValue(1);
  smitesCounterStub.increment.mockResolvedValue(1);
  mockSignalSend.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  // `resetPlayer` reads the rank table through this cache on its way out; without a real-shaped
  // answer it throws on `ranks.find` and the third-strike case would fail for the wrong reason.
  mockFetchThroughCache.mockResolvedValue([
    { type: 'Acolyte', name: 'Acolyte', minExp: 0, iconUrl: null },
  ]);
});

describe('smitePlayer — onSmiteCreated is the durable-write signal', () => {
  it('fires once with the committed row, before any of the non-durable tail runs', async () => {
    const seen: Array<{ id: number }> = [];
    // 🔴 Ordering is the claim, not just the call, and it is pinned against the FIRST tail step —
    // the active-smite `count` — not against the counter increment further down.
    //
    // Why that distinction is the whole test: between the count and the increment sits
    // `if (activeSmiteCount >= 3) return resetPlayer(...)`. A hook moved below that `if` is still
    // above the increment, so an ordering assertion written against the increment holds and the
    // move survives — while on the third strike, where the branch returns early, the hook now never
    // fires at all. The severest outcome an account can reach would file as "No action was taken by
    // this scan". Pinning the first tail step leaves no step for the hook to sink past unnoticed.
    const order: string[] = [];
    mockCount.mockImplementation(async () => {
      order.push('count');
      return 1;
    });
    smitesCounterStub.increment.mockImplementation(async () => {
      order.push('increment');
      return 1;
    });

    await call((smite) => {
      order.push('hook');
      seen.push(smite);
    });

    expect(order).toEqual(['hook', 'count', 'increment']);
    expect(seen).toEqual([{ ...SMITE_ROW }]);
    expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
  });

  it('🔴 fires BEFORE a third-strike career reset — the severest path, and the one that returns early', async () => {
    // The branch the rest of this file deliberately stays under, exercised here because it is the
    // one where the hook is load-bearing and the one no other assertion can reach: `smitePlayer`
    // RETURNS `resetPlayer(...)`, so every step below the `if` is skipped. A caller that learned
    // "smited" from anything downstream of that branch learns nothing about a reset account.
    mockCount.mockResolvedValue(3);
    const order: string[] = [];
    mockCleanseSmites.mockImplementation(() => {
      order.push('cleanse');
      return undefined;
    });

    await call(() => {
      order.push('hook');
    });

    // The branch really ran. Without this the case is vacuous — "the hook fired" is equally true on
    // the sub-threshold path, so the assertion would pass while testing nothing new.
    expect(mockCleanseSmites).toHaveBeenCalledWith({
      where: { targetPlayerId: 7, cleansedAt: null },
      data: expect.objectContaining({ cleansedAt: expect.any(Date) }),
    });
    // …and the early return really happened: the increment below the `if` was never reached.
    expect(smitesCounterStub.increment).not.toHaveBeenCalled();

    expect(order).toEqual(['hook', 'cleanse']);
  });

  it('🔴 still fires when the tail THROWS — the penalty is live and the caller must hear about it', async () => {
    // The measured mechanism behind the board bug: `smitesCounter.increment` re-throws a
    // non-connection error out of `getCount` and then writes to `sysRedis` with no guard at all,
    // unlike the fail-open `setCacheValue` beside it. The row is already committed at that point.
    smitesCounterStub.increment.mockRejectedValue(new Error('counter backend unavailable'));
    const seen: Array<{ id: number }> = [];

    await expect(
      call((smite) => {
        seen.push(smite);
      })
    ).rejects.toThrow('counter backend unavailable');

    // Both halves, as a pair: the call failed AND the penalty landed. Either alone is the wrong
    // story to tell a moderator.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ ...SMITE_ROW }]);
  });

  it('does NOT fire when the row itself was never written', async () => {
    // The negative control. Without it, a hook wired to fire unconditionally would pass the case
    // above and file every failed smite as an applied one — the exact inverse error.
    mockCreate.mockRejectedValue(new Error('db down'));
    const onSmiteCreated = vi.fn();

    await expect(call(onSmiteCreated)).rejects.toThrow('db down');

    expect(onSmiteCreated).not.toHaveBeenCalled();
  });

  it('a hook that THROWS does not abort the tail, and the failure is LOGGED', async () => {
    // The precondition used to be prose on the parameter — "must not throw" — which is a request,
    // not a guard, on a seam any future caller can reach. `smitePlayer` has already committed the
    // penalty by this point, so a caller's own bug must not be able to strand the account with a
    // live smite and no counter, signal or notification.
    await expect(
      call(() => {
        throw new Error('caller hook exploded');
      })
    ).resolves.not.toThrow();

    expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
    expect(mockSignalSend).toHaveBeenCalledTimes(1);

    // 🔴 CONTAINED IS NOT THE SAME AS SWALLOWED, and the catch was bare until this assertion existed.
    // Before this seam was exported the throw reached the abuse-detection job's own `handleLogError`;
    // a silent catch here removed that without replacing it, so a caller's bug became invisible on
    // the one path where the penalty is already live. The KEY is asserted, not just the call: an
    // alert can match a stable key and cannot match a sentence, and a bare `toHaveBeenCalled()`
    // would pass on any unrelated log the tail happens to emit.
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'caller hook exploded' }),
      'new-order:smite-hook-failed',
      { smiteId: SMITE_ROW.id }
    );
  });

  it('🔴 a hook that REJECTS is contained too — the shape the `try` alone cannot reach', async () => {
    // An `async` hook is the shape a future caller is most likely to write, and it is NOT covered by
    // the `try` alone. `Promise.resolve(onSmiteCreated?.(smite))` cannot catch it either way round: a
    // sync throw happens during argument evaluation, before `Promise.resolve` runs, while a
    // rejection happens after the `try` block has already exited. Only the `.catch` on the result
    // reaches it, and without that it is a genuine unhandled rejection — this process installs no
    // global `unhandledRejection` handler to fall back on.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        call(async () => {
          throw new Error('caller hook rejected');
        })
      ).resolves.not.toThrow();

      // The tail ran to completion, exactly as for the synchronous shape.
      expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
      expect(mockSignalSend).toHaveBeenCalledTimes(1);

      expect(mockHandleLogError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'caller hook rejected' }),
        'new-order:smite-hook-failed',
        { smiteId: SMITE_ROW.id }
      );

      // A macrotask turn, so a rejection left without a handler has actually been reported by the
      // time this is read. Asserting it directly is what makes this a test of the defect rather than
      // of the log line: the log could be produced and the rejection still escape.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('🔴 contains a SYNCHRONOUS non-`Error` throw — `throw null`, which the logger cannot deref', async () => {
    // `handleLogError` builds `new Error(e.message ?? …)` with no guard, so handing it `null`
    // throws a TypeError from INSIDE the `catch` block — past the only handler there is. The tail
    // is then skipped entirely and `smitePlayer` rejects, which is the half-applied smite the
    // containment is there to prevent: the row is committed, the counter, signal and notification
    // are not. `throw null` is not exotic — it is what a rethrown API payload or a bare
    // `Promise.reject(err)` value looks like once it has been through a serialiser.
    await expect(
      call(() => {
        throw null;
      })
    ).resolves.not.toThrow();

    // The tail really ran. This is the assertion the faithful `handleLogError` mock exists for —
    // against a bare `vi.fn()` it would pass without the fix.
    expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
    expect(mockSignalSend).toHaveBeenCalledTimes(1);

    // …and the failure was still reported, as an `Error` the logger can actually consume. Pinning
    // `expect.any(Error)` is the structural half: it fails on the raw `null` regardless of whether
    // the mock happens to deref it.
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order:smite-hook-failed',
      { smiteId: SMITE_ROW.id }
    );
  });

  it('🔴 contains a throw value that cannot be STRINGIFIED — `Object.create(null)`', async () => {
    // A different mechanism from `throw null` above, one line earlier: there the logger could not
    // deref the value, here the NORMALISATION cannot convert it. `String(e)` on a null-prototype
    // object throws `TypeError: Cannot convert object to primitive value`, and it runs inside the
    // `catch` that exists to contain the hook — so the tail is skipped and `smitePlayer` rejects
    // with the row already committed, the same half-applied smite. An object with a throwing
    // `toString` and a revoked `Proxy` are the same defect through the same line; this pins the
    // shape that needs no setup to build.
    await expect(
      call(() => {
        throw Object.create(null);
      })
    ).resolves.not.toThrow();

    // Both halves, as a pair. Before the value was carried as `cause`, the call rejected with
    // `TypeError: Cannot convert object to primitive value` and this line read 0 — the tail skipped
    // outright, which is the whole defect and not something the rejection alone establishes.
    expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
    expect(mockSignalSend).toHaveBeenCalledTimes(1);

    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order:smite-hook-failed',
      { smiteId: SMITE_ROW.id }
    );
  });

  it('🔴 contains an ASYNC non-`Error` rejection — the same value, arriving down the `.catch`', async () => {
    // Same unguarded deref, reached the other way: the TypeError is thrown inside the `.catch`
    // handler, so the derived promise rejects with nothing left to catch it. The `void` in front
    // means it is never awaited, so this surfaces as an unhandled rejection rather than a failed
    // call — the tail completes and the defect is invisible from the call site.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        call(async () => {
          throw null;
        })
      ).resolves.not.toThrow();

      expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
      expect(mockSignalSend).toHaveBeenCalledTimes(1);

      expect(mockHandleLogError).toHaveBeenCalledWith(
        expect.any(Error),
        'new-order:smite-hook-failed',
        { smiteId: SMITE_ROW.id }
      );

      // A macrotask turn, so a rejection left without a handler has been reported by the time this
      // is read. Without it the assertion would run before the report and pass either way.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('is optional — a caller that passes nothing is unaffected', async () => {
    // Three of the four call sites do not hook this, so the absent case is the common one.
    await expect(call()).resolves.toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
