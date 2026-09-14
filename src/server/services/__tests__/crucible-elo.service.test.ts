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
  estimateEloChange,
  getAllEntryElos,
  getEntryElo,
  getKFactor,
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

describe('getKFactor', () => {
  it('returns the provisional K below the threshold', () => {
    expect(getKFactor(0)).toBe(K_FACTOR_PROVISIONAL);
    expect(getKFactor(PROVISIONAL_VOTE_THRESHOLD - 1)).toBe(K_FACTOR_PROVISIONAL);
  });

  it('returns the established K at and above the threshold', () => {
    expect(getKFactor(PROVISIONAL_VOTE_THRESHOLD)).toBe(K_FACTOR_ESTABLISHED);
    expect(getKFactor(500)).toBe(K_FACTOR_ESTABLISHED);
  });
});

describe('estimateEloChange', () => {
  it('splits the K evenly when both entries are level', () => {
    expect(estimateEloChange(1500, 1500)).toEqual([16, -16]);
    expect(estimateEloChange(1500, 1500, K_FACTOR_PROVISIONAL)).toEqual([32, -32]);
  });

  it('awards less for beating a weaker entry than a stronger one', () => {
    const [beatWeaker] = estimateEloChange(1800, 1200);
    const [beatStronger] = estimateEloChange(1200, 1800);

    expect(beatWeaker).toBeLessThan(beatStronger);
    expect(beatWeaker).toBeGreaterThanOrEqual(0);
  });

  it('is zero-sum at every rating gap, so the pool cannot inflate', () => {
    const gaps = [0, 25, 100, 400, 1200, -400];
    for (const gap of gaps) {
      const [winner, loser] = estimateEloChange(1500 + gap, 1500);
      expect(winner + loser).toBe(0);
    }
  });

  it('never exceeds the K it was given', () => {
    for (const gap of [0, 200, 800, -800]) {
      const [winner] = estimateEloChange(1500 + gap, 1500, K_FACTOR_PROVISIONAL);
      expect(Math.abs(winner)).toBeLessThanOrEqual(K_FACTOR_PROVISIONAL);
    }
  });

  it('defaults to the established K when none is passed', () => {
    expect(estimateEloChange(1500, 1500)).toEqual(
      estimateEloChange(1500, 1500, K_FACTOR_ESTABLISHED)
    );
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

  it('derives each K-factor from that entry own vote count', async () => {
    processVoteAtomic.mockResolvedValue(atomicResult);

    await processVote(7, 101, 102, 3, 40);

    // Provisional winner, established loser — the service must not collapse them to one value
    // before handing them to Redis; the Lua script is what averages them.
    expect(processVoteAtomic).toHaveBeenCalledWith(
      7,
      101,
      102,
      K_FACTOR_PROVISIONAL,
      K_FACTOR_ESTABLISHED
    );
  });

  it('returns the ELO the Lua script computed, not its own recomputation', async () => {
    processVoteAtomic.mockResolvedValue({ ...atomicResult, winnerElo: 1600, loserElo: 1400 });

    const result = await processVote(7, 101, 102, 0, 0);

    expect(result).toEqual({ winnerElo: 1600, loserElo: 1400 });
  });

  it('propagates a Redis failure rather than reporting a vote that did not land', async () => {
    processVoteAtomic.mockRejectedValue(new Error('redis down'));

    await expect(processVote(7, 101, 102, 0, 0)).rejects.toThrow('redis down');
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
