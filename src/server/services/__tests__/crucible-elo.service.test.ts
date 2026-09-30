import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';

const processVoteAtomic = vi.fn();
const initializeElo = vi.fn();
const getElo = vi.fn();
const getAllElos = vi.fn();

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { processVoteAtomic, initializeElo, getElo, getAllElos },
}));

const {
  CRUCIBLE_DEFAULT_ELO,
  K_FACTOR_ESTABLISHED,
  K_FACTOR_PROVISIONAL,
  PROVISIONAL_VOTE_THRESHOLD,
  getAllEntryElos,
  getEntryElo,
  initializeEntryElo,
  processVote,
} = await import('~/server/services/crucible-elo.service');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('constants', () => {
  it('starts every entry at 1500', () => {
    expect(CRUCIBLE_DEFAULT_ELO).toBe(1500);
  });

  it('uses a higher K while provisional so early ratings converge faster', () => {
    expect(K_FACTOR_PROVISIONAL).toBe(64);
    expect(K_FACTOR_ESTABLISHED).toBe(32);
    expect(K_FACTOR_PROVISIONAL).toBeGreaterThan(K_FACTOR_ESTABLISHED);
  });

  it('treats an entry as established at 10 votes', () => {
    expect(PROVISIONAL_VOTE_THRESHOLD).toBe(10);
  });
});

describe('processVote', () => {
  const atomicResult = {
    winnerElo: 1532,
    loserElo: 1468,
    winnerOldElo: 1500,
    loserOldElo: 1500,
    winnerChange: 32,
    loserChange: -32,
  };

  it('hands the script both K-factors and the threshold, so it picks each side from the counts it reads', async () => {
    processVoteAtomic.mockResolvedValue(atomicResult);

    await processVote(7, 101, 102);

    expect(processVoteAtomic).toHaveBeenCalledWith(7, 101, 102, {
      provisionalK: K_FACTOR_PROVISIONAL,
      establishedK: K_FACTOR_ESTABLISHED,
      provisionalVotes: PROVISIONAL_VOTE_THRESHOLD,
    });
  });

  it('returns the ELO the Lua script computed, not its own recomputation', async () => {
    processVoteAtomic.mockResolvedValue({ ...atomicResult, winnerElo: 1600, loserElo: 1400 });

    const result = await processVote(7, 101, 102);

    expect(result).toEqual({ winnerElo: 1600, loserElo: 1400 });
  });

  it('propagates a Redis failure rather than reporting a vote that did not land', async () => {
    processVoteAtomic.mockRejectedValue(new Error('redis down'));

    await expect(processVote(7, 101, 102)).rejects.toThrow('redis down');
  });
});

describe('getEntryElo', () => {
  it('returns the stored score', async () => {
    getElo.mockResolvedValue(1723);
    expect(await getEntryElo(1, 55)).toBe(1723);
  });

  it('falls back to the default for an entry Redis has never seen', async () => {
    getElo.mockResolvedValue(null);
    expect(await getEntryElo(1, 55)).toBe(CRUCIBLE_DEFAULT_ELO);
  });

  it('does not mistake a legitimate score of 0 for a missing entry', async () => {
    getElo.mockResolvedValue(0);
    expect(await getEntryElo(1, 55)).toBe(0);
  });
});

describe('initializeEntryElo and getAllEntryElos', () => {
  it('initializes through the Redis client', async () => {
    initializeElo.mockResolvedValue(undefined);
    await initializeEntryElo(4, 9);
    expect(initializeElo).toHaveBeenCalledWith(4, 9);
  });

  it('passes the whole crucible map back unchanged', async () => {
    getAllElos.mockResolvedValue({ 1: 1520, 2: 1480 });
    expect(await getAllEntryElos(4)).toEqual({ 1: 1520, 2: 1480 });
  });
});
