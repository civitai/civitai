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

const { smitesCounterStub, counterStub, mockCreateNotification, mockSignalSend } = vi.hoisted(
  () => {
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
    };
  }
);

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
  handleLogError: vi.fn(),
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
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

const SMITE_ROW = {
  id: 4321,
  targetPlayerId: 7,
  givenById: 1,
  reason: 'r',
  size: 50,
  remaining: 50,
};

const call = (onSmiteCreated?: (smite: { id: number }) => void) =>
  smitePlayer({ playerId: 7, modId: 1, reason: 'r', size: 50, onSmiteCreated });

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(SMITE_ROW);
  // Below the third-strike rule, so the career-reset branch stays out of the way.
  mockCount.mockResolvedValue(1);
  smitesCounterStub.increment.mockResolvedValue(1);
  mockSignalSend.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
});

describe('smitePlayer — onSmiteCreated is the durable-write signal', () => {
  it('fires once with the committed row, before any of the non-durable tail runs', async () => {
    const seen: Array<{ id: number }> = [];
    // Ordering is the claim, not just the call: a hook that fired at the END would be a rename of
    // "the call returned" and would carry none of the information this whole mechanism exists for.
    smitesCounterStub.increment.mockImplementation(async () => {
      expect(seen).toHaveLength(1);
      return 1;
    });

    await call((smite) => {
      seen.push(smite);
    });

    expect(seen).toEqual([{ ...SMITE_ROW }]);
    expect(smitesCounterStub.increment).toHaveBeenCalledTimes(1);
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

  it('is optional — a caller that passes nothing is unaffected', async () => {
    // Three of the four call sites do not hook this, so the absent case is the common one.
    await expect(call()).resolves.toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
