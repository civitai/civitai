import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import { CRUCIBLE_DEFAULT_ELO } from '~/server/redis/crucible-elo.redis';
import { createPairKey } from '~/server/services/crucible-judge-closure';
import {
  getAnchorVotesKey,
  getJudgesKey,
  getVotedPairsKey,
} from '~/server/services/crucible-redis-keys';

/**
 * Votes from one winner over one loser. `frozen` names a side these votes do not move, as in the
 * Elo update: an entry the judge had already voted on as often as allowed.
 */
export type PairTally = {
  winnerEntryId: number;
  loserEntryId: number;
  votes: number;
  frozen?: 'winner' | 'loser';
};

/** One judge's vote on one pair. */
export type JudgeVote = { userId: number; winnerEntryId: number; loserEntryId: number };

const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-6;

/**
 * Bradley-Terry strengths from all judges' votes (minorize-maximize, Hunter 2004). Each entry also
 * gets one win and one loss against a virtual opponent of strength 1, so an entry that never lost
 * stays finite and one-vote entries stay near the middle instead of flying to the extremes.
 *
 * A frozen side's votes are left out of that entry's own update, the way Elo leaves its rating
 * alone, but its strength still places the other side.
 */
export function fitBradleyTerryStrengths(tallies: PairTally[]): Map<number, number> {
  const wins = new Map<number, number>();
  const games = new Map<number, Map<number, number>>();
  const addGames = (a: number, b: number, n: number) => {
    let row = games.get(a);
    if (!row) games.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + n);
  };
  for (const { winnerEntryId: w, loserEntryId: l, votes, frozen } of tallies) {
    if (w === l || votes <= 0) continue;
    if (!wins.has(w)) wins.set(w, 0);
    if (!wins.has(l)) wins.set(l, 0);
    if (frozen !== 'winner') {
      wins.set(w, wins.get(w)! + votes);
      addGames(w, l, votes);
    }
    if (frozen !== 'loser') addGames(l, w, votes);
  }

  const ids = [...wins.keys()];
  let strength = new Map(ids.map((id) => [id, 1]));
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = new Map<number, number>();
    for (const id of ids) {
      const p = strength.get(id)!;
      // Prior: one game each way against the virtual opponent of strength 1.
      let denominator = 2 / (p + 1);
      for (const [opponent, n] of games.get(id) ?? [])
        denominator += n / (p + strength.get(opponent)!);
      next.set(id, (wins.get(id)! + 1) / denominator);
    }
    let maxChange = 0;
    for (const id of ids) {
      maxChange = Math.max(maxChange, Math.abs(Math.log(next.get(id)! / strength.get(id)!)));
    }
    strength = next;
    if (maxChange < TOLERANCE) break;
  }
  return strength;
}

/**
 * The fitted strengths on the Elo scale (1500 at the geometric mean), so a fitted score reads like
 * the live one and can stand in for it.
 */
export function fitBradleyTerry(tallies: PairTally[]): Map<number, number> {
  const strength = fitBradleyTerryStrengths(tallies);
  const ids = [...strength.keys()];
  const meanLog =
    ids.reduce((sum, id) => sum + Math.log10(strength.get(id)!), 0) / (ids.length || 1);
  return new Map(
    ids.map((id) => [
      id,
      Math.round(CRUCIBLE_DEFAULT_ELO + 400 * (Math.log10(strength.get(id)!) - meanLog)),
    ])
  );
}

/** A judge's anchors: pair key (`small:large`) -> the entry Elo left frozen on that vote. */
export type JudgeAnchors = Map<number, Map<string, number>>;

/**
 * Judges' votes as the tallies the fit takes. A vote's frozen side is the anchor Elo recorded for
 * it when it was cast (see `RECORD_VOTED_PAIR_SCRIPT`), so the fit freezes exactly what Elo froze.
 */
export function tallyJudgeVotes(votes: JudgeVote[], anchors: JudgeAnchors): PairTally[] {
  const tallies = new Map<string, PairTally>();
  for (const { userId, winnerEntryId, loserEntryId } of votes) {
    const anchor = anchors.get(userId)?.get(createPairKey(winnerEntryId, loserEntryId));
    const frozen =
      anchor === winnerEntryId ? 'winner' : anchor === loserEntryId ? 'loser' : undefined;
    const key = `${winnerEntryId}>${loserEntryId}|${frozen ?? ''}`;
    const tally = tallies.get(key);
    if (tally) tally.votes++;
    else tallies.set(key, { winnerEntryId, loserEntryId, votes: 1, frozen });
  }
  return [...tallies.values()];
}

/**
 * When the fit, not Elo, ranks a crucible (display and prizes): crucibles starting on or after this
 * date. Null ranks none. Floor: anchor recording (#7748, shipped in 5.1.435) was live in prod by
 * 2026-11-04T21:25Z (5.1.436 live); a crucible starting before then has anchorless votes, so it
 * must finish on Elo.
 */
export const BRADLEY_TERRY_RANKING_FROM: Date | null = new Date('2026-11-06T00:00:00Z');

export function usesBradleyTerryRanking(
  crucible: { startAt: Date | null; createdAt: Date },
  from = BRADLEY_TERRY_RANKING_FROM
) {
  if (!from) return false;
  return (crucible.startAt ?? crucible.createdAt) >= from;
}

/**
 * Every judge's votes in a crucible, one per judge and pair. ClickHouse can hold repeated rows,
 * and any one row of the group stands for the vote; winner and loser come from the same row, so
 * even a group holding both A>B and B>A yields a real vote, never A>A. The inner
 * aliases must not reuse a column name: ClickHouse would read the GROUP BY's columns as them.
 *
 * shortcut: one row per vote, read on every sync and finalize. A judge casts at most
 * CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY votes per entry, so this is bounded by judges times
 * entries; store the tallies per crucible if large crucibles make it slow.
 */
async function fetchJudgeVotes(crucibleId: number): Promise<JudgeVote[]> {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const rows = await clickhouse.$query<JudgeVote>`
    SELECT judge AS userId, p.1 AS winnerEntryId, p.2 AS loserEntryId
    FROM (
      SELECT userId AS judge, any((winnerEntryId, loserEntryId)) AS p
      FROM crucible_votes
      WHERE crucibleId = ${crucibleId}
      GROUP BY userId, least(winnerEntryId, loserEntryId), greatest(winnerEntryId, loserEntryId)
    )
  `;
  return rows.map((row) => ({
    userId: Number(row.userId),
    winnerEntryId: Number(row.winnerEntryId),
    loserEntryId: Number(row.loserEntryId),
  }));
}

/** For display: the fit over whatever ClickHouse holds now, lag and all. */
export async function fitCrucibleScores(crucibleId: number) {
  const [{ anchors }, votes] = await Promise.all([
    readRedisJudging(crucibleId),
    fetchJudgeVotes(crucibleId),
  ]);
  return fitBradleyTerry(tallyJudgeVotes(votes, anchors));
}

const JUDGE_BATCH = 100;

/**
 * Per judge, in bounded batches: the pairs Redis counts as judged (the sum of every judge's
 * voted-pairs set, which the prize guard compares) and the anchors Elo recorded.
 */
async function readRedisJudging(crucibleId: number) {
  const judges = ((await sysRedis.sMembers(getJudgesKey(crucibleId))) ?? []).map(Number);
  let judgedPairs = 0;
  const anchors: JudgeAnchors = new Map();
  for (let i = 0; i < judges.length; i += JUDGE_BATCH) {
    const batch = judges.slice(i, i + JUDGE_BATCH);
    const [counts, anchorHashes] = await Promise.all([
      Promise.all(batch.map((userId) => sysRedis.sCard(getVotedPairsKey(crucibleId, userId)))),
      Promise.all(batch.map((userId) => sysRedis.hGetAll(getAnchorVotesKey(crucibleId, userId)))),
    ]);
    judgedPairs += counts.reduce((sum, n) => sum + n, 0);
    batch.forEach((userId, j) => {
      const hash = Object.entries(anchorHashes[j] ?? {});
      if (hash.length) anchors.set(userId, new Map(hash.map(([pair, id]) => [pair, Number(id)])));
    });
  }
  return { judgedPairs, anchors };
}

/** How long after a crucible ends finalize waits for ClickHouse to catch up before paying by Elo. */
export const BRADLEY_TERRY_INGEST_WAIT_MS = 10 * 60 * 1000;

/** ClickHouse is still short of Redis: finalize stops before writing anything, and the next run retries. */
export class CrucibleRankingDeferredError extends Error {}

/**
 * The fit prizes are paid from, or null to pay from Elo. Fits only when ClickHouse holds exactly
 * the votes Redis says were cast. When ClickHouse has fewer and the crucible ended less than
 * `BRADLEY_TERRY_INGEST_WAIT_MS` ago, it throws `CrucibleRankingDeferredError` so the every-minute
 * job tries again, never sleeping inside finalize. It falls back at once when ClickHouse has more
 * votes than Redis or either store is unreachable, and once the wait is over when ClickHouse is
 * still short. A judge set gone with its 30-day TTL also falls back, by mismatch.
 */
export async function fitCrucibleScoresForPrizes(
  crucibleId: number,
  { endedAt, now = new Date() }: { endedAt: Date | null; now?: Date }
): Promise<Map<number, number> | null> {
  let clickhouseVotes = 0;
  let redisVotes = 0;
  try {
    const { judgedPairs, anchors } = await readRedisJudging(crucibleId);
    redisVotes = judgedPairs;
    const votes = await fetchJudgeVotes(crucibleId);
    clickhouseVotes = votes.length;
    if (clickhouseVotes === redisVotes) return fitBradleyTerry(tallyJudgeVotes(votes, anchors));
  } catch (error) {
    logToAxiom({
      type: 'warning',
      name: 'crucible-bradley-terry-fallback',
      message: `Crucible ${crucibleId} ranks by Elo: could not read its votes`,
      crucibleId,
      error: error instanceof Error ? error.message : String(error),
    }).catch();
    return null;
  }
  const lagging =
    clickhouseVotes < redisVotes &&
    now.getTime() - (endedAt ?? now).getTime() < BRADLEY_TERRY_INGEST_WAIT_MS;
  if (lagging)
    throw new CrucibleRankingDeferredError(
      `Crucible ${crucibleId}: ClickHouse has ${clickhouseVotes} of ${redisVotes} votes, waiting`
    );
  logToAxiom({
    type: 'warning',
    name: 'crucible-bradley-terry-fallback',
    message: `Crucible ${crucibleId} ranks by Elo: ClickHouse has ${clickhouseVotes} votes, Redis ${redisVotes}`,
    crucibleId,
    clickhouseVotes,
    redisVotes,
  }).catch();
  return null;
}
