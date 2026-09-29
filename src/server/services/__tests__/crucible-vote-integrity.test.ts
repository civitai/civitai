import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { submitVoteSchema } from '~/server/schema/crucible.schema';
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

const { submitVote, CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } = await import(
  '~/server/services/crucible.service'
);

const JUDGE = 42;
const vote = (winnerEntryId = 10, loserEntryId = 20) =>
  submitVote({ crucibleId: 1, winnerEntryId, loserEntryId, userId: JUDGE });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({
    id: 1,
    status: CrucibleStatus.Active,
    endAt: new Date(Date.now() + 60_000),
    contentType: MediaType.image,
    minViewSeconds: null,
  });
  dbMock.dbRead.crucibleEntry.findUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    crucibleId: 1,
    userId: where.id + 1000,
  }));
  processVote.mockResolvedValue({ winnerElo: 1516, loserElo: 1484 });
  redisMock.sysRedis.sRem.mockResolvedValue(1);
  redisMock.sysRedis.hGet.mockResolvedValue(null);
});

describe('submitVote — a vote needs two different entries', () => {
  it('is refused by the input schema', () => {
    const parsed = submitVoteSchema.safeParse({
      crucibleId: 1,
      winnerEntryId: 10,
      loserEntryId: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it('is refused by the service before any rating moves', async () => {
    await expect(vote(10, 10)).rejects.toThrow('two different entries');
    expect(processVote).not.toHaveBeenCalled();
  });
});

describe('submitVote — only a pair this judge was served', () => {
  it('claims the served pair for this judge and crucible', async () => {
    await vote(20, 10);

    expect(redisMock.sysRedis.sRem).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`:1:${JUDGE}$`)),
      '10:20'
    );
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('refuses a pair that was never served, or was already claimed', async () => {
    redisMock.sysRedis.sRem.mockResolvedValue(0);

    await expect(vote()).rejects.toThrow('no longer available');
    expect(processVote).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });
});

describe('submitVote — per-judge cap on each entry', () => {
  it('refuses once the judge has voted on either entry as often as allowed', async () => {
    redisMock.sysRedis.hGet.mockImplementation(async (_key: string, field: string) =>
      field === '20' ? String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY) : null
    );

    await expect(vote()).rejects.toThrow('as many times as allowed');
    expect(processVote).not.toHaveBeenCalled();
    // Refused before the served pair is claimed, so it is not burned.
    expect(redisMock.sysRedis.sRem).not.toHaveBeenCalled();
  });

  it('counts both entries toward the judge on an accepted vote', async () => {
    await vote();

    expect(redisMock.sysRedis.hIncrBy).toHaveBeenCalledWith(expect.any(String), '10', 1);
    expect(redisMock.sysRedis.hIncrBy).toHaveBeenCalledWith(expect.any(String), '20', 1);
  });
});
