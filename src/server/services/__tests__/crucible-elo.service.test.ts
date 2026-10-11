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

    expect(processVoteAtomic).toHaveBeenCalledWith(
      7,
      101,
      102,
      {
        provisionalK: K_FACTOR_PROVISIONAL,
        establishedK: K_FACTOR_ESTABLISHED,
        provisionalVotes: PROVISIONAL_VOTE_THRESHOLD,
      },
      undefined,
      undefined
    );
  });

  it('hands the script the last synced ratings to fall back on', async () => {
    processVoteAtomic.mockResolvedValue(atomicResult);
    const stored = {
      winner: { score: 1700, voteCount: 25 },
      loser: { score: 1400, voteCount: 12 },
    };

    await processVote(7, 101, 102, stored);

    expect(processVoteAtomic).toHaveBeenCalledWith(
      7,
      101,
      102,
      expect.any(Object),
      stored,
      undefined
    );
  });

  it('hands the script the side an anchor vote leaves as it is', async () => {
    processVoteAtomic.mockResolvedValue(atomicResult);

    await processVote(7, 101, 102, undefined, 'loser');

    expect(processVoteAtomic).toHaveBeenCalledWith(
      7,
      101,
      102,
      expect.any(Object),
      undefined,
      'loser'
    );
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

describe('CrucibleEloRedisClient.processVoteAtomic', () => {
  const k = { provisionalK: 64, establishedK: 32, provisionalVotes: 10 };
  const run = async (
    ...rest:
      | []
      | [
          Parameters<typeof client.processVoteAtomic>[4],
          Parameters<typeof client.processVoteAtomic>[5]?
        ]
  ) => {
    evalScript.mockResolvedValue([1700, 1400, 1705, 1395, 5, -5]);
    await client.processVoteAtomic(9, 1, 2, k, ...rest);
    return evalScript.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
  };
  const evalScript = vi.fn();
  let client: InstanceType<typeof CrucibleEloRedis.CrucibleEloRedisClient>;

  beforeEach(async () => {
    const { CrucibleEloRedisClient } = await vi.importActual<typeof CrucibleEloRedis>(
      '~/server/redis/crucible-elo.redis'
    );
    client = new CrucibleEloRedisClient({ eval: evalScript } as never);
  });

  // Verified against a live Redis: with both hashes wiped, a vote continues from these values
  // (1700/25 -> 1705/26) instead of restarting at 1500/0. A unit test can't run the Lua, so the
  // arguments and the fallbacks the script reads are what's pinned here.
  it("passes each entry's stored score and vote count to the script", async () => {
    const [script, { arguments: args }] = await run({
      winner: { score: 1700, voteCount: 25 },
      loser: { score: 1400, voteCount: 12 },
    });

    expect(args.slice(5, 9)).toEqual(['1700', '25', '1400', '12']);
    expect(script).toContain("redis.call('HGET', eloKey, winnerField)) or winnerStoredElo");
    expect(script).toContain("redis.call('HGET', votesKey, loserField)) or loserStoredVotes");
    expect(script).toContain("redis.call('HSET', votesKey, winnerField, winnerVotes + 1)");
    expect(script).not.toContain('HINCRBY');
  });

  it("falls back to a new entry's rating when given none", async () => {
    const [, { arguments: args }] = await run();
    expect(args.slice(5)).toEqual(['1500', '0', '1500', '0', '']);
  });

  it.each(['winner', 'loser'] as const)(
    'tells the script to leave the %s of an anchor vote as it is',
    async (side) => {
      const [script, { arguments: args }] = await run(undefined, side);
      const change = side === 'winner' ? 'winnerChange' : 'loserChange';
      const field = side === 'winner' ? 'winnerField' : 'loserField';
      const votes = side === 'winner' ? 'winnerVotes' : 'loserVotes';
      const newElo = side === 'winner' ? 'newWinnerElo' : 'newLoserElo';

      expect(args[9]).toBe(side);
      expect(script).toContain('local frozen = ARGV[10]');
      expect(script).toContain(`if frozen == '${side}' then ${change} = 0 end`);
      expect(script).toMatch(
        new RegExp(
          `if frozen ~= '${side}' then\\s+` +
            `redis\\.call\\('HSET', eloKey, ${field}, ${newElo}\\)\\s+` +
            `redis\\.call\\('HSET', votesKey, ${field}, ${votes} \\+ 1\\)\\s+end`
        )
      );
    }
  );
});
