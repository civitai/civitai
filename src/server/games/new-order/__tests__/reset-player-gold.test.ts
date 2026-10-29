import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('~/server/services/user.service', () => ({ awardTrophyCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: mockSignalSend, topicSend: vi.fn() },
}));

// Import AFTER mocks.
import { resetPlayer } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('resetPlayer and Knights gold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchThroughCache.mockResolvedValue([]);
  });

  it('forfeits unconverted gold in the same transaction as the reset itself', async () => {
    await resetPlayer({ playerId: 7 }).catch(() => undefined);

    const [operations] = dbMock.dbWrite.$transaction.mock.calls[0];
    expect(operations).toHaveLength(3);
    const [update] = dbMock.dbWrite.newOrderPlayer.update.mock.calls[0];
    expect(update.where).toEqual({ userId: 7 });
    // startAt is set by the SQL below, from the database clock under the row lock
    expect(update.data).not.toHaveProperty('startAt');
    const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain('"startAt" = clock_timestamp()');
    expect(sql).toContain('"goldPending" = 0');
    expect(sql).toContain('"goldEarned" = "goldConverted"');
    expect(sql).toContain('"goldCleared" = "goldConverted"');
    expect(values).toEqual([7]);
  });
});
