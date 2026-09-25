import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';

const processVoteAtomic = vi.fn();

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: {
    processVoteAtomic,
    initializeElo: vi.fn(),
    getElo: vi.fn(),
    getAllElos: vi.fn(),
  },
}));

const { processVote } = await import('~/server/services/crucible-elo.service');

/**
 * The ELO read-compute-write runs inside a Lua script on the Redis server so concurrent votes
 * cannot lose updates. Nothing in a unit test can execute that Lua, so what is pinned here is the
 * property that makes it load-bearing: the service must never do the arithmetic itself, and every
 * vote must be exactly one atomic call.
 */
beforeEach(() => {
  vi.clearAllMocks();
  processVoteAtomic.mockImplementation(async () => ({
    winnerElo: 1532,
    loserElo: 1468,
    winnerOldElo: 1500,
    loserOldElo: 1500,
    winnerChange: 32,
    loserChange: -32,
  }));
});

describe('concurrent votes', () => {
  it('issues exactly one atomic call per vote', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => processVote(1, 100 + i, 200 + i, 0, 0)));

    expect(processVoteAtomic).toHaveBeenCalledTimes(20);
  });

  it('never reads the current ELO before writing — that gap is the lost-update race', async () => {
    const { crucibleEloRedis } = await import('~/server/redis/crucible-elo.redis');

    await processVote(1, 101, 102, 0, 0);

    expect(crucibleEloRedis.getElo).not.toHaveBeenCalled();
    expect(crucibleEloRedis.getAllElos).not.toHaveBeenCalled();
  });

  it('does not serialise votes behind one another', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    processVoteAtomic.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return {
        winnerElo: 1532,
        loserElo: 1468,
        winnerOldElo: 1500,
        loserOldElo: 1500,
        winnerChange: 32,
        loserChange: -32,
      };
    });

    await Promise.all(Array.from({ length: 5 }, () => processVote(1, 101, 102, 0, 0)));

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('reports each vote result independently rather than sharing state', async () => {
    let call = 0;
    processVoteAtomic.mockImplementation(async () => {
      call++;
      return {
        winnerElo: 1500 + call,
        loserElo: 1500 - call,
        winnerOldElo: 1500,
        loserOldElo: 1500,
        winnerChange: call,
        loserChange: -call,
      };
    });

    const results = await Promise.all([
      processVote(1, 101, 102, 0, 0),
      processVote(1, 103, 104, 0, 0),
      processVote(1, 105, 106, 0, 0),
    ]);

    const winners = results.map((r) => r.winnerElo).sort();
    expect(new Set(winners).size).toBe(3);
  });

  it('surfaces a failure for the vote that failed without poisoning the others', async () => {
    let call = 0;
    processVoteAtomic.mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('redis timeout');
      return {
        winnerElo: 1532,
        loserElo: 1468,
        winnerOldElo: 1500,
        loserOldElo: 1500,
        winnerChange: 32,
        loserChange: -32,
      };
    });

    const results = await Promise.allSettled([
      processVote(1, 101, 102, 0, 0),
      processVote(1, 103, 104, 0, 0),
      processVote(1, 105, 106, 0, 0),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('the Lua script itself', () => {
  // The script is a template literal inside the Redis client and never executes in this suite, so
  // the two properties the atomicity argument rests on are pinned textually. Both were regressions
  // once already (US001/US006 on the original branch).
  const source = readFileSync(path.join(__dirname, '../../redis/crucible-elo.redis.ts'), 'utf8');

  it('computes the loser change as the negation of the winner change, so votes are zero-sum', () => {
    expect(source).toContain('local loserChange = -winnerChange');
  });

  it('averages the two K-factors, so unequal K cannot inflate the pool', () => {
    expect(source).toContain('local avgK = (winnerK + loserK) / 2');
  });

  it('reads and writes both scores inside the script rather than round-tripping to node', () => {
    expect(source).toContain("redis.call('HGET', eloKey, winnerField)");
    expect(source).toContain("redis.call('HSET', eloKey, winnerField, newWinnerElo)");
    expect(source).toContain("redis.call('HSET', eloKey, loserField, newLoserElo)");
  });
});
