import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as CrucibleEloService from '~/server/services/crucible-elo.service';

const processVote = vi.fn();

vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloService>()),
  processVote,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: {
    getVoteCount: vi.fn().mockResolvedValue(0),
    incrementVoteCount: vi.fn().mockResolvedValue(undefined),
  },
}));

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const { submitVote } = await import('~/server/services/crucible.service');

const crucibleRow = (contentType: MediaType, minViewSeconds: number | null) => ({
  id: 1,
  status: CrucibleStatus.Active,
  endAt: new Date(Date.now() + 60_000),
  contentType,
  minViewSeconds,
});

const vote = (watched?: { winnerWatchedMs?: number; loserWatchedMs?: number }) =>
  submitVote({ crucibleId: 1, winnerEntryId: 10, loserEntryId: 20, userId: 42, ...watched });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video, 6));
  dbMock.dbRead.crucibleEntry.findUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    crucibleId: 1,
    userId: where.id === 10 ? 101 : 102,
  }));
  processVote.mockResolvedValue({ winnerElo: 1532, loserElo: 1468 });
});

describe('submitVote — minimum view time', () => {
  it('accepts a vote where both sides cleared the bar', async () => {
    await expect(vote({ winnerWatchedMs: 6000, loserWatchedMs: 7200 })).resolves.toMatchObject({
      winnerElo: 1532,
    });
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('accepts a vote exactly at the threshold on both sides', async () => {
    await expect(vote({ winnerWatchedMs: 6000, loserWatchedMs: 6000 })).resolves.toMatchObject({
      winnerElo: 1532,
    });
  });

  it.each([
    ['the winner', { winnerWatchedMs: 5999, loserWatchedMs: 6000 }],
    ['the loser', { winnerWatchedMs: 6000, loserWatchedMs: 5999 }],
    ['both sides', { winnerWatchedMs: 0, loserWatchedMs: 0 }],
  ])('rejects a vote where %s fell short', async (_label, watched) => {
    await expect(vote(watched)).rejects.toThrow(/Watch at least 6s of both/);
    expect(processVote).not.toHaveBeenCalled();
  });

  it('rejects a vote that omits the watch times entirely', async () => {
    // The gate has to fail closed: a client that simply does not send the field is the cheapest
    // possible bypass, and it is exactly what an older client does.
    await expect(vote()).rejects.toThrow(/Watch at least 6s of both/);
    expect(processVote).not.toHaveBeenCalled();
  });

  it('rejects BEFORE marking the pair voted, so a short vote does not burn the pair', async () => {
    // Marking first would consume the judge's one shot at this pair and leave them unable to
    // vote on it after watching properly.
    await expect(vote({ winnerWatchedMs: 0, loserWatchedMs: 0 })).rejects.toThrow();

    const { sysRedis } = await import('~/server/redis/client');
    expect(sysRedis.sAdd).not.toHaveBeenCalled();
  });
});

describe('submitVote — crucibles with no minimum', () => {
  it('accepts a vote with no watch times when the crucible sets no minimum', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video, null));

    await expect(vote()).resolves.toMatchObject({ winnerElo: 1532 });
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('accepts a vote on an image crucible, which has nothing to watch', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image, null));

    await expect(vote()).resolves.toMatchObject({ winnerElo: 1532 });
  });
});
