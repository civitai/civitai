import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzApiError } from '@civitai/buzz';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CrucibleConstants from '~/shared/constants/crucible.constants';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PostService from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';

const findUnique = dbMock.dbWrite.crucible.findUnique;
const executeRaw = dbMock.dbWrite.$executeRaw;
const claim = dbMock.dbWrite.$queryRaw;
const refundTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const getMultiAccountTransactionsByPrefix = vi.fn();
const getTransactionByExternalId = vi.fn();
const setTTL = vi.fn();
const createNotification = vi.fn();
const afterPostsPublish = vi.fn();
const trackModActivity = vi.fn();
const policy = vi.hoisted(() => ({
  shipped: undefined as unknown as 'forfeit' | 'refund' | 'hold',
  mode: undefined as unknown as 'forfeit' | 'refund' | 'hold',
}));

vi.mock('~/shared/constants/crucible.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof CrucibleConstants>();
  policy.shipped = actual.CRUCIBLE_TAKEDOWN_CREATOR_FUNDS;
  return {
    ...actual,
    get CRUCIBLE_TAKEDOWN_CREATOR_FUNDS() {
      return policy.mode;
    },
  };
});

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
  refundTransaction,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { setTTL },
}));

const { takeDownCrucible, cancelCrucible } = await import('~/server/services/crucible.service');

const CREATOR = 4;
const MOD = 1;
const SETUP = 'crucible-setup-4-abc';
const SEED = 'crucible-seed-4-abc';
const REASON = 'Brief breaks the content rules';

const crucible = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Liminal Stuff',
  ingestion: CrucibleIngestionStatus.Scanned,
  textNsfw: false,
  userId: CREATOR,
  status: CrucibleStatus.Cancelled,
  entryFee: 100,
  buzzTransactionId: SETUP,
  seededPrizePool: 1500,
  seedTransactionId: SEED,
  takenDownAt: new Date('2026-10-30T07:19:00Z'),
  takedownReason: REASON,
  takedownRefundsCreator: false,
  entries: [
    { id: 1, userId: 10, buzzTransactionId: 'entry-1-10' },
    { id: 2, userId: 11, buzzTransactionId: 'entry-2-11' },
    // The creator's own entry is refunded but not sent the entrants' notice.
    { id: 3, userId: CREATOR, buzzTransactionId: 'entry-3-4' },
  ],
  ...overrides,
});

const refundedPrefixes = () =>
  refundMultiAccountTransaction.mock.calls.map(
    ([input]) => (input as { externalTransactionIdPrefix: string }).externalTransactionIdPrefix
  );
const notification = (type: string) =>
  createNotification.mock.calls.map(([n]) => n).filter((n) => n.type === type);
const rawSql = () =>
  [...executeRaw.mock.calls, ...dbMock.dbWrite.$queryRaw.mock.calls].map(([strings]) =>
    Array.isArray(strings) ? strings.join('?') : String(strings)
  );

beforeEach(() => {
  vi.clearAllMocks();
  policy.mode = policy.shipped;
  executeRaw.mockResolvedValue(1);
  claim.mockResolvedValue([{ previousStatus: CrucibleStatus.Active }]);
  findUnique.mockResolvedValue(crucible());
  setTTL.mockResolvedValue(undefined);
  refundMultiAccountTransaction.mockResolvedValue({ refundedTransactions: [{ amount: 100 }] });
  getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) => [
    { transactionId: `${prefix}-leg`, externalTransactionId: `${prefix}-User`, amount: 100 },
  ]);
  getTransactionByExternalId.mockResolvedValue({ type: 'Refund' });
  refundTransaction.mockResolvedValue({ transactionId: 'refunded' });
  createNotification.mockResolvedValue(undefined);
  afterPostsPublish.mockResolvedValue(undefined);
  trackModActivity.mockResolvedValue(undefined);
});

const takeDown = (input: { reason?: string; releaseCreatorFunds?: boolean } = {}) =>
  takeDownCrucible({ id: 1, reason: REASON, moderatorId: MOD, ...input });

describe('takeDownCrucible — money', () => {
  it('under the shipped policy, refunds every entrant and not the creator', async () => {
    const result = await takeDown();

    expect(refundedPrefixes().sort()).toEqual(['entry-1-10', 'entry-2-11', 'entry-3-4']);
    expect(result.creatorFunds).toBe('forfeited');
  });

  it('pays nobody twice on a re-run', async () => {
    claim.mockResolvedValueOnce([]);
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));

    const result = await takeDown();

    expect(result.alreadySettled).toBe(3);
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it('reports the creator refunded when only an entrant refund failed', async () => {
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: true }));
    refundMultiAccountTransaction.mockImplementation(
      async (input: { externalTransactionIdPrefix: string }) => {
        if (input.externalTransactionIdPrefix === 'entry-2-11') throw new BuzzApiError(500, 'down');
        return { refundedTransactions: [{ amount: 100 }] };
      }
    );

    expect((await takeDown()).creatorFunds).toBe('refunded');
  });

  it('counts a seed alone as creator funds', async () => {
    findUnique.mockResolvedValue(crucible({ buzzTransactionId: null }));

    expect((await takeDown()).creatorFunds).toBe('forfeited');
  });

  it('reports no creator funds for a crucible that took none', async () => {
    findUnique.mockResolvedValue(crucible({ buzzTransactionId: null, seedTransactionId: null }));

    const result = await takeDown();

    expect(result.creatorFunds).toBe('none');
  });

  it('tells entrants whose refund failed that it is being processed, and returns what is owed', async () => {
    refundMultiAccountTransaction.mockImplementation(
      async (input: { externalTransactionIdPrefix: string }) => {
        if (input.externalTransactionIdPrefix === 'entry-2-11') throw new BuzzApiError(500, 'down');
        return { refundedTransactions: [{ amount: 100 }] };
      }
    );

    const result = await takeDown();

    expect(result.failedRefunds).toEqual([expect.objectContaining({ entryId: 2, userId: 11 })]);
    const notices = notification('crucible-removed');
    expect(notices.find((n) => n.details.refundPending)?.userIds).toEqual([11]);
    expect(notices.find((n) => !n.details.refundPending)?.userIds).toEqual([10]);
  });

  // Owed when a cancel came first; whether the claim records that is the .sql.behavior test.
  it('refunds the creator when the takedown owes it, re-run or not, and says so', async () => {
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: true }));

    const first = await takeDown();
    claim.mockResolvedValueOnce([]);
    const rerun = await takeDown();

    expect(refundedPrefixes().filter((p) => p === SETUP || p === SEED)).toEqual([
      SETUP,
      SEED,
      SETUP,
      SEED,
    ]);
    expect([first.creatorFunds, rerun.creatorFunds]).toEqual(['refunded', 'refunded']);
  });

  it('always refunds entrants', async () => {
    const result = await takeDown();

    expect(refundedPrefixes()).toEqual(
      expect.arrayContaining(['entry-1-10', 'entry-2-11', 'entry-3-4'])
    );
    expect(result.refundedEntries).toBe(3);
  });

  it.each([
    ['refund', true, 'refunded'],
    ['forfeit', false, 'forfeited'],
    ['hold', false, 'held'],
  ] as const)('under %s, refunds the creator: %s', async (mode, refunded, creatorFunds) => {
    policy.mode = mode;
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: refunded }));

    const result = await takeDown();

    const creatorPrefixes = refundedPrefixes().filter((p) => p === SETUP || p === SEED);
    expect(creatorPrefixes).toEqual(refunded ? [SETUP, SEED] : []);
    expect(result.creatorFunds).toBe(creatorFunds);
    expect(notification('crucible-taken-down')[0].details.creatorFunds).toBe(creatorFunds);
  });

  it('releases held creator funds on a re-run that asks for it, and says so once', async () => {
    policy.mode = 'hold';
    claim.mockResolvedValueOnce([]); // already taken down
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: true }));

    const result = await takeDown({ releaseCreatorFunds: true });

    expect(refundedPrefixes()).toEqual(expect.arrayContaining([SETUP, SEED]));
    expect(result.creatorFunds).toBe('refunded');
    expect(notification('crucible-taken-down')[0].key).toBe('crucible-taken-down-released:1');
  });

  it('sends no release notice when the creator refund fails, so the retry can', async () => {
    policy.mode = 'hold';
    claim.mockResolvedValueOnce([]);
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: true }));
    refundMultiAccountTransaction.mockImplementation(
      async (input: { externalTransactionIdPrefix: string }) => {
        if (input.externalTransactionIdPrefix === SEED) throw new BuzzApiError(500, 'down');
        return { refundedTransactions: [{ amount: 100 }] };
      }
    );

    const result = await takeDown({ releaseCreatorFunds: true });

    expect(result.creatorFunds).toBe('pending');
    expect(notification('crucible-taken-down')).toEqual([]);
  });

  it.each(['refund', 'forfeit'] as const)(
    'refuses to release creator funds under %s, before anything moves',
    async (mode) => {
      policy.mode = mode;

      await expect(takeDown({ releaseCreatorFunds: true })).rejects.toThrow(
        /no held creator funds/
      );
      expect(claim).not.toHaveBeenCalled();
      expect(refundedPrefixes()).toEqual([]);
    }
  );
});

describe('takeDownCrucible — states', () => {
  it('hides a Completed crucible without moving any money or touching its posts', async () => {
    policy.mode = 'refund';
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));

    const result = await takeDown();

    expect(refundedPrefixes()).toEqual([]);
    expect(result.creatorFunds).toBe('none');
    expect(executeRaw).not.toHaveBeenCalled(); // no entry-post write
    expect(notification('crucible-taken-down')).toHaveLength(1);
    // Nobody was refunded, so nobody is told they were.
    expect(notification('crucible-removed')[0].details.refunded).toBe(false);
  });

  it('refuses a crucible finalize owns, before any money moves', async () => {
    claim.mockResolvedValueOnce([]);
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Active, takenDownAt: null }));

    await expect(takeDown()).rejects.toThrow(/being finalized/);
    expect(refundedPrefixes()).toEqual([]);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('keeps the first reason when re-run with a different one', async () => {
    claim.mockResolvedValueOnce([]);

    await takeDown({ reason: 'A different, later reason' });

    // The stored reason; that the row keeps it is crucible-takedown.sql.behavior.test.ts.
    expect(notification('crucible-taken-down')[0].details.reason).toBe(REASON);
  });

  it('records the moderator action', async () => {
    await takeDown();

    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'crucible',
      activity: 'takeDown',
      entityId: 1,
    });
  });
});

describe('takeDownCrucible — content', () => {
  it('deletes nothing: no posts, images, entries, comments or the crucible', async () => {
    await takeDown();

    expect(calledHybridNodes(['dbWrite']).filter((path) => /\.delete(Many)?$/.test(path))).toEqual(
      []
    );
    expect(rawSql().filter((sql) => /\bDELETE\b/i.test(sql))).toEqual([]);
  });

  it('does not reveal entry posts, as a cancel does', async () => {
    await takeDown();

    expect(afterPostsPublish).not.toHaveBeenCalled();
    expect(rawSql().some((sql) => /"publishedAt" = now\(\)/.test(sql))).toBe(false);
  });
});

describe('takeDownCrucible — notices', () => {
  it('tells the creator the reason, and entrants only that it was removed', async () => {
    await takeDown();

    const [creator] = notification('crucible-taken-down');
    expect(creator).toMatchObject({ userId: CREATOR, details: { reason: REASON } });

    const entrants = notification('crucible-removed');
    expect(entrants).toHaveLength(1);
    expect(entrants[0].userIds).toEqual([10, 11]);
    expect(entrants[0].details).not.toHaveProperty('reason');
    expect(notification('crucible-cancelled')).toEqual([]);
  });
});

describe('cancelCrucible on a taken-down crucible', () => {
  const recancel = () => cancelCrucible({ id: 1, userId: MOD, isModerator: true });
  beforeEach(() => {
    dbMock.dbWrite.crucible.updateMany.mockResolvedValue({ count: 0 });
  });

  it('finishes entrant refunds but cannot refund the creator around the takedown', async () => {
    await recancel();

    expect(refundedPrefixes().sort()).toEqual(['entry-1-10', 'entry-2-11', 'entry-3-4']);
  });

  it('finishes the creator refund the takedown owes', async () => {
    findUnique.mockResolvedValue(crucible({ takedownRefundsCreator: true }));

    await recancel();

    expect(refundedPrefixes()).toEqual(expect.arrayContaining([SETUP, SEED]));
  });

  it('records the refunds on the ledger as for a removed crucible', async () => {
    await recancel();

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('crucible removed') })
    );
  });

  it('sends no cancel notice when a takedown lands while its refunds run', async () => {
    dbMock.dbWrite.crucible.updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValueOnce(
      crucible({ status: CrucibleStatus.Active, takenDownAt: null })
    );

    const result = await recancel();

    expect(result.takenDown).toBe(true);
    expect(notification('crucible-cancelled')).toEqual([]);
  });

  it('sends the cancel notice when no takedown came (control)', async () => {
    dbMock.dbWrite.crucible.updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Active, takenDownAt: null }));

    const result = await recancel();

    expect(result.takenDown).toBe(false);
    expect(notification('crucible-cancelled')).not.toEqual([]);
  });

  it('neither reveals its entry posts nor sends the cancel notice', async () => {
    await recancel();

    expect(afterPostsPublish).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(notification('crucible-cancelled')).toEqual([]);
  });
});
