import { describe, it, expect, vi, beforeEach } from 'vitest';
// Namespace type-import (erased at compile time, so it is safe above the hoisted vi.mock calls) —
// the repo forbids inline `typeof import(...)` annotations.
import type * as ChallengeMetrics from '~/server/prom/challenge.metrics';

// Covers the two DB-facing halves of the duplicate-payout guard:
//
//  P0-a  `getExistingWinnersForRetry` must read the PRIMARY. An empty result routes the completion
//        into a fresh, non-deterministic LLM re-pick rather than aborting, so a replica that had not
//        yet caught up would hand back "no winners" for a challenge that already has (already paid)
//        winners.
//
//  P0-b  `createChallengeWinner` must RESOLVE a (challengeId, userId) conflict instead of swallowing
//        it. The stored row keeps the original place; returning `null` let the caller pay the
//        freshly-picked place under a brand-new externalTransactionId — a second prize.

const {
  mockDbReadQueryRaw,
  mockDbWriteQueryRaw,
  mockCreate,
  mockFindUnique,
  mockLogToAxiom,
  mockRecordDivergence,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn().mockResolvedValue([]),
  mockDbWriteQueryRaw: vi.fn().mockResolvedValue([]),
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockRecordDivergence: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: mockDbReadQueryRaw },
  dbWrite: {
    $queryRaw: mockDbWriteQueryRaw,
    challengeWinner: { create: mockCreate, findUnique: mockFindUnique },
  },
}));
vi.mock('~/server/redis/client', () => ({ redis: {}, REDIS_KEYS: {} }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: vi.fn((e: unknown) => e),
}));
vi.mock('~/server/prom/challenge.metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof ChallengeMetrics>();
  return { ...actual, recordChallengeWinnerPlaceDivergence: mockRecordDivergence };
});

const { createChallengeWinner, getExistingWinnersForRetry } = await import(
  '~/server/games/daily-challenge/challenge-helpers'
);
const { Prisma } = await import('@prisma/client');

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const INPUT = {
  challengeId: 69,
  userId: 100,
  imageId: 1,
  place: 1,
  buzzAwarded: 500,
  pointsAwarded: 10,
  reason: 'best',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbReadQueryRaw.mockResolvedValue([]);
  mockDbWriteQueryRaw.mockResolvedValue([]);
});

describe('getExistingWinnersForRetry (P0-a)', () => {
  it('reads the primary, not a replica', async () => {
    const rows = [
      { userId: 100, imageId: 1, place: 1, buzzAwarded: 500, pointsAwarded: 10, reason: 'r' },
    ];
    mockDbWriteQueryRaw.mockResolvedValue(rows);

    await expect(getExistingWinnersForRetry(69)).resolves.toEqual(rows);

    expect(mockDbWriteQueryRaw).toHaveBeenCalledTimes(1);
    // A replica read here is the failure mode: stale "no winners" routes into a fresh re-pick.
    expect(mockDbReadQueryRaw).not.toHaveBeenCalled();
  });

  it('passes the challengeId to the query', async () => {
    await getExistingWinnersForRetry(1234);
    // Tagged-template call: (strings, ...values) — the challengeId is the only interpolated value.
    expect(mockDbWriteQueryRaw.mock.calls[0][1]).toBe(1234);
  });
});

describe('createChallengeWinner (P0-b)', () => {
  it('returns the inserted row as created on a fresh insert', async () => {
    mockCreate.mockResolvedValue({ id: 5, place: 1, buzzAwarded: 500, pointsAwarded: 10 });

    await expect(createChallengeWinner(INPUT)).resolves.toEqual({
      id: 5,
      place: 1,
      buzzAwarded: 500,
      pointsAwarded: 10,
      created: true,
    });
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockRecordDivergence).not.toHaveBeenCalled();
  });

  it('on a conflict re-reads the stored row from the primary and returns its place, not the attempted one', async () => {
    mockCreate.mockRejectedValue(p2002());
    mockFindUnique.mockResolvedValue({ id: 5, place: 3, buzzAwarded: 100, pointsAwarded: 2 });

    await expect(createChallengeWinner(INPUT)).resolves.toEqual({
      id: 5,
      place: 3, // stored, NOT the attempted place 1
      buzzAwarded: 100, // stored, NOT the attempted 500
      pointsAwarded: 2,
      created: false,
    });

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { challengeId_userId: { challengeId: 69, userId: 100 } },
      })
    );
  });

  it('logs a warning and increments the divergence metric when the stored place differs', async () => {
    mockCreate.mockRejectedValue(p2002());
    mockFindUnique.mockResolvedValue({ id: 5, place: 3, buzzAwarded: 100, pointsAwarded: 2 });

    await createChallengeWinner(INPUT);

    expect(mockRecordDivergence).toHaveBeenCalledWith({ field: 'both' });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'challenge-winner-place-divergence',
        storedPlace: 3,
        attemptedPlace: 1,
      })
    );
  });

  it('labels a place-only divergence as place', async () => {
    mockCreate.mockRejectedValue(p2002());
    mockFindUnique.mockResolvedValue({ id: 5, place: 2, buzzAwarded: 500, pointsAwarded: 10 });

    await createChallengeWinner(INPUT);

    expect(mockRecordDivergence).toHaveBeenCalledWith({ field: 'place' });
  });

  it('an identical duplicate stays info-level and does not touch the divergence metric', async () => {
    mockCreate.mockRejectedValue(p2002());
    mockFindUnique.mockResolvedValue({ id: 5, place: 1, buzzAwarded: 500, pointsAwarded: 10 });

    await expect(createChallengeWinner(INPUT)).resolves.toEqual({
      id: 5,
      place: 1,
      buzzAwarded: 500,
      pointsAwarded: 10,
      created: false,
    });

    expect(mockRecordDivergence).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', name: 'challenge-winner-duplicate' })
    );
  });

  it('returns null and warns when the conflict resolves to no readable row', async () => {
    mockCreate.mockRejectedValue(p2002());
    mockFindUnique.mockResolvedValue(null);

    await expect(createChallengeWinner(INPUT)).resolves.toBeNull();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'challenge-winner-conflict-unresolved',
      })
    );
  });

  it('rethrows a non-P2002 error', async () => {
    mockCreate.mockRejectedValue(new Error('connection reset'));
    await expect(createChallengeWinner(INPUT)).rejects.toThrow('connection reset');
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
