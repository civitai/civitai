import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks';
import type * as Logging from '~/server/logging/client';

const chQuery = vi.fn();
const logToAxiom = vi.fn(async () => undefined);
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQuery } }));
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Logging>()),
  logToAxiom,
}));

const { fitBradleyTerry, fitCrucibleScoresForPrizes } = await import(
  '~/server/services/crucible-bradley-terry'
);

describe('fitBradleyTerry', () => {
  it('orders a consistent set of votes the way they point', () => {
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 3 },
      { winnerEntryId: 2, loserEntryId: 3, votes: 3 },
      { winnerEntryId: 1, loserEntryId: 3, votes: 1 },
    ]);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
    expect(scores.get(2)!).toBeGreaterThan(scores.get(3)!);
  });

  it('keeps an entry that never lost finite', () => {
    const scores = fitBradleyTerry([{ winnerEntryId: 1, loserEntryId: 2, votes: 50 }]);
    expect(Number.isFinite(scores.get(1))).toBe(true);
    expect(scores.get(1)! - scores.get(2)!).toBeLessThan(1200);
  });

  it('centres on 1500 and scores an even split level', () => {
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 4 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 4 },
    ]);
    expect(scores.get(1)).toBe(1500);
    expect(scores.get(2)).toBe(1500);
  });

  it('ranks by who was beaten, not by raw wins: beating the strongest counts for more', () => {
    // 3 is strong (beats 4 and 5 often). 1 beats 3 once; 2 beats only weak 5, twice.
    const scores = fitBradleyTerry([
      { winnerEntryId: 3, loserEntryId: 4, votes: 5 },
      { winnerEntryId: 3, loserEntryId: 5, votes: 5 },
      { winnerEntryId: 1, loserEntryId: 3, votes: 1 },
      { winnerEntryId: 2, loserEntryId: 5, votes: 2 },
    ]);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
  });

  it('ranks the same however the votes are ordered', () => {
    const tallies = [
      { winnerEntryId: 1, loserEntryId: 2, votes: 3 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 1 },
      { winnerEntryId: 2, loserEntryId: 3, votes: 2 },
      { winnerEntryId: 3, loserEntryId: 4, votes: 4 },
      { winnerEntryId: 4, loserEntryId: 1, votes: 1 },
      { winnerEntryId: 1, loserEntryId: 5, votes: 2 },
    ];
    const expected = [...fitBradleyTerry(tallies)].sort(([a], [b]) => a - b);
    for (const shuffled of [[...tallies].reverse(), [3, 0, 5, 1, 4, 2].map((i) => tallies[i])]) {
      expect([...fitBradleyTerry(shuffled)].sort(([a], [b]) => a - b)).toEqual(expected);
    }
  });

  it('maps onto the Elo scale: 400 points apart means 10-to-1 odds', () => {
    // 10 wins to 1 between two entries; the prior adds one each way against a level opponent, so
    // the gap lands a little under 400.
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 100 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 10 },
    ]);
    expect(scores.get(1)! + scores.get(2)!).toBe(3000);
    expect(scores.get(1)! - scores.get(2)!).toBeGreaterThan(370);
    expect(scores.get(1)! - scores.get(2)!).toBeLessThan(400);
  });

  it('scores nothing without votes', () => {
    expect(fitBradleyTerry([]).size).toBe(0);
  });
});

describe('fitCrucibleScoresForPrizes — the prize-ranking guard', () => {
  const tallies = [
    { winnerEntryId: 1, loserEntryId: 2, votes: 2 },
    { winnerEntryId: 2, loserEntryId: 3, votes: 1 },
  ]; // 3 distinct (judge, pair) votes
  /** Two judges whose voted-pairs sets hold `a` and `b` pairs. */
  const withRedisPairs = (a: number, b: number) => {
    redisMock.sysRedis.sMembers.mockResolvedValue(['7', '8']);
    redisMock.sysRedis.sCard.mockImplementation(async (key: string) =>
      key.endsWith(':7') ? a : key.endsWith(':8') ? b : 0
    );
  };
  const fit = () => fitCrucibleScoresForPrizes(1, { attempts: 3, retryMs: 0 });
  const warned = () =>
    logToAxiom.mock.calls.map(([entry]) => (entry as { message: string }).message);

  beforeEach(() => {
    vi.clearAllMocks();
    chQuery.mockResolvedValue(tallies);
  });

  it('ranks by the fit when ClickHouse holds exactly the votes Redis counts', async () => {
    withRedisPairs(2, 1);
    const scores = await fit();
    expect(scores, 'fitted scores').not.toBeNull();
    expect(scores!.get(1)!).toBeGreaterThan(scores!.get(3)!);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('falls back to Elo and names both counts when they never match', async () => {
    withRedisPairs(2, 2);
    expect(await fit(), 'scores on a mismatch').toBeNull();
    expect(chQuery, 'ClickHouse re-read for lag').toHaveBeenCalledTimes(3);
    expect(warned()).toEqual(['Crucible 1 ranks by Elo: ClickHouse has 3 votes, Redis 4']);
  });

  it('waits out ingest lag: a short first read that then catches up still fits', async () => {
    withRedisPairs(2, 1);
    chQuery.mockResolvedValueOnce(tallies.slice(0, 1));
    expect(await fit(), 'scores after a lagging read').not.toBeNull();
    expect(chQuery).toHaveBeenCalledTimes(2);
  });

  it('does not wait when ClickHouse holds more votes than Redis: lag cannot explain that', async () => {
    withRedisPairs(1, 1);
    expect(await fit()).toBeNull();
    expect(chQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back to Elo when ClickHouse is unreachable', async () => {
    withRedisPairs(2, 1);
    chQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await fit()).toBeNull();
    expect(warned()).toEqual(['Crucible 1 ranks by Elo: could not read its votes']);
  });

  it('falls back to Elo when Redis is unreachable', async () => {
    redisMock.sysRedis.sMembers.mockRejectedValue(new Error('redis down'));
    expect(await fit()).toBeNull();
  });
});
