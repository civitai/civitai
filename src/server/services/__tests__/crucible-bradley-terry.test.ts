import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock, redisMock } from '~/__tests__/mocks';
import {
  getAnchorVotesKey,
  getJudgesKey,
  getVotedPairsKey,
} from '~/server/services/crucible-redis-keys';

const chQuery = vi.fn();
const logToAxiom = loggingMock.logToAxiom;
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQuery } }));

const {
  BRADLEY_TERRY_INGEST_WAIT_MS,
  BRADLEY_TERRY_RANKING_FROM,
  CrucibleRankingDeferredError,
  fitBradleyTerry,
  fitBradleyTerryStrengths,
  fitCrucibleScoresForPrizes,
  tallyJudgeVotes,
  usesBradleyTerryRanking,
} = await import('~/server/services/crucible-bradley-terry');

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
  // ClickHouse rows: 3 distinct (judge, pair) votes.
  const judgeVotes = [
    { userId: 7, winnerEntryId: 1, loserEntryId: 2 },
    { userId: 7, winnerEntryId: 2, loserEntryId: 3 },
    { userId: 8, winnerEntryId: 1, loserEntryId: 2 },
  ];
  /**
   * Two judges whose voted-pairs sets hold `a` and `b` pairs. Only the exact keys the vote path
   * writes answer (the writer side is pinned in crucible-vote-integrity), so a guard that reads
   * any other key counts 0 and these tests fail.
   */
  const withRedisPairs = (a: number, b: number) => {
    redisMock.sysRedis.sMembers.mockImplementation(async (key: string) =>
      key === getJudgesKey(1) ? ['7', '8'] : []
    );
    redisMock.sysRedis.sCard.mockImplementation(async (key: string) =>
      key === getVotedPairsKey(1, 7) ? a : key === getVotedPairsKey(1, 8) ? b : 0
    );
  };
  const now = new Date('2026-12-01T12:00:00Z');
  const endedAgo = (ms: number) => new Date(now.getTime() - ms);
  const fit = (endedAt = endedAgo(BRADLEY_TERRY_INGEST_WAIT_MS + 1)) =>
    fitCrucibleScoresForPrizes(1, { endedAt, now });

  beforeEach(() => {
    vi.clearAllMocks();
    chQuery.mockResolvedValue(judgeVotes);
  });

  it('ranks by the fit when ClickHouse holds exactly the votes Redis counts', async () => {
    withRedisPairs(2, 1);
    const scores = await fit();
    expect(scores, 'fitted scores').not.toBeNull();
    expect(scores!.get(1)!).toBeGreaterThan(scores!.get(3)!);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('defers while ClickHouse is short and the crucible ended moments ago (ingest lag)', async () => {
    withRedisPairs(2, 2);
    await expect(fit(endedAgo(60_000))).rejects.toBeInstanceOf(CrucibleRankingDeferredError);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('falls back to Elo and names both counts once the wait is over', async () => {
    withRedisPairs(2, 2);
    expect(await fit(), 'scores on a mismatch').toBeNull();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', clickhouseVotes: 3, redisVotes: 4 })
    );
  });

  it('does not wait when ClickHouse holds more votes than Redis: lag cannot explain that', async () => {
    withRedisPairs(1, 1);
    expect(await fit(endedAgo(60_000))).toBeNull();
  });

  it('falls back to Elo when ClickHouse is unreachable', async () => {
    withRedisPairs(2, 1);
    chQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await fit(endedAgo(60_000))).toBeNull();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('counts every judge when there are more than one batch of them', async () => {
    const judges = Array.from({ length: 250 }, (_, i) => i + 1);
    redisMock.sysRedis.sMembers.mockResolvedValue(judges.map(String));
    let inFlight = 0;
    let maxInFlight = 0;
    redisMock.sysRedis.sCard.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return 1;
    });
    chQuery.mockResolvedValue(
      judges.map((userId) => ({ userId, winnerEntryId: 1, loserEntryId: 2 }))
    );
    expect(await fit(), 'fit over 250 judges').not.toBeNull();
    expect(redisMock.sysRedis.sCard).toHaveBeenCalledTimes(250);
    expect(maxInFlight, 'SCARDs in flight at once').toBe(100);
  });

  it('pays from a fit that freezes the anchors Redis recorded for each judge', async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((loser) => ({
      userId: 9,
      winnerEntryId: 10,
      loserEntryId: loser,
    }));
    const anchors = new Map([[9, new Map([6, 7, 8].map((loser) => [`${loser}:10`, 10]))]]);
    redisMock.sysRedis.sMembers.mockImplementation(async (key: string) =>
      key === getJudgesKey(1) ? ['9'] : []
    );
    redisMock.sysRedis.sCard.mockImplementation(async (key: string) =>
      key === getVotedPairsKey(1, 9) ? 8 : 0
    );
    redisMock.sysRedis.hGetAll.mockImplementation(async (key: string) =>
      key === getAnchorVotesKey(1, 9) ? { '6:10': '10', '7:10': '10', '8:10': '10' } : {}
    );
    chQuery.mockResolvedValue(rows);

    const scores = await fit();
    expect(scores).toEqual(fitBradleyTerry(tallyJudgeVotes(rows, anchors)));
    expect(scores, 'differs from a fit that ignores the anchors').not.toEqual(
      fitBradleyTerry(tallyJudgeVotes(rows, new Map()))
    );
  });

  it('falls back to Elo when Redis is unreachable', async () => {
    redisMock.sysRedis.sMembers.mockRejectedValue(new Error('redis down'));
    expect(await fit(endedAgo(60_000))).toBeNull();
  });
});

describe('the per-judge, per-entry cap, as Elo recorded it', () => {
  // Judge 1 votes X (10) over A-E: five votes, all counted for X.
  const firstFive = [1, 2, 3, 4, 5].map((loser) => ({
    userId: 1,
    winnerEntryId: 10,
    loserEntryId: loser,
  }));
  // Then X over F-H with X at the cap: Elo recorded X as the anchor, so these place F-H only.
  const pastCap = [6, 7, 8].map((loser) => ({ userId: 1, winnerEntryId: 10, loserEntryId: loser }));
  const xAnchored = new Map([[1, new Map([6, 7, 8].map((loser) => [`${loser}:10`, 10]))]]);

  it('moves an entry a judge voted on 8 times exactly as if they had cast only 5', () => {
    const onlyFive = fitBradleyTerryStrengths(tallyJudgeVotes(firstFive, new Map()));
    const eight = fitBradleyTerryStrengths(tallyJudgeVotes([...firstFive, ...pastCap], xAnchored));
    // Strength ratios are scale-free; the fit's centring moves with F-H, the ratios do not.
    for (const opponent of [1, 2, 3, 4, 5]) {
      const ratio = (fit: Map<number, number>) => Math.log10(fit.get(10)! / fit.get(opponent)!);
      expect(ratio(eight), `X against ${opponent}`).toBeCloseTo(ratio(onlyFive), 6);
    }
    // F-H still lose to X, so they place below it.
    expect(eight.get(6)!).toBeLessThan(eight.get(10)!);
  });

  it('freezes the recorded side, whichever side it is, and only for that judge', () => {
    const votes = [
      { userId: 1, winnerEntryId: 10, loserEntryId: 6 }, // anchor 10: the winner
      { userId: 1, winnerEntryId: 7, loserEntryId: 10 }, // anchor 10: the loser
      { userId: 2, winnerEntryId: 10, loserEntryId: 6 }, // another judge, no anchor
    ];
    const anchors = new Map([
      [
        1,
        new Map([
          ['6:10', 10],
          ['7:10', 10],
        ]),
      ],
    ]);
    const frozen = tallyJudgeVotes(votes, anchors)
      .map((t) => `${t.winnerEntryId}>${t.loserEntryId}:${t.frozen ?? '-'}x${t.votes}`)
      .sort();
    expect(frozen).toEqual(['10>6:-x1', '10>6:winnerx1', '7>10:loserx1']);
  });
});

describe('usesBradleyTerryRanking — which crucibles the fit ranks', () => {
  const from = new Date('2026-12-01T00:00:00Z');
  const crucible = (startAt: string | null, createdAt = '2026-11-01T00:00:00Z') => ({
    startAt: startAt ? new Date(startAt) : null,
    createdAt: new Date(createdAt),
  });

  // The fit freezes anchors only for votes cast after anchor recording was live in prod
  // (2026-11-04T21:25Z); a crucible starting before that has anchorless votes and must stay on Elo.
  it('switches on no earlier than the release that records anchors', () => {
    expect(BRADLEY_TERRY_RANKING_FROM).not.toBeNull();
    expect(BRADLEY_TERRY_RANKING_FROM!.getTime()).toBeGreaterThanOrEqual(
      Date.parse('2026-11-04T21:25:00Z')
    );
  });

  it('ranks crucibles starting on or after the date, and leaves earlier ones on Elo', () => {
    expect(usesBradleyTerryRanking(crucible('2026-12-01T00:00:00Z'), from)).toBe(true);
    expect(usesBradleyTerryRanking(crucible('2026-11-30T23:59:00Z'), from)).toBe(false);
  });

  // Anchors are recorded only from the deploy that ships the fit on: a crucible already judging
  // then has votes without them, so it must finish on Elo however late it ends.
  it('leaves a crucible that started before the date on Elo, even when it ends after it', () => {
    const running = {
      ...crucible('2026-11-30T12:00:00Z'),
      endAt: new Date('2026-12-05T00:00:00Z'),
    };
    expect(usesBradleyTerryRanking(running, from)).toBe(false);
  });

  it('goes by creation time for a crucible with no start time', () => {
    expect(usesBradleyTerryRanking(crucible(null, '2026-12-02T00:00:00Z'), from)).toBe(true);
    expect(usesBradleyTerryRanking(crucible(null), from)).toBe(false);
  });
});
