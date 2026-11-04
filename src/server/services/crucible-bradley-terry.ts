import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

export type PairTally = { winnerEntryId: number; loserEntryId: number; votes: number };

const ELO_BASE = 1500;
const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-6;

/**
 * Bradley-Terry strengths from all judges' votes, on the Elo scale (1500 at the geometric mean),
 * so a fitted score reads like the live one and can stand in for it.
 *
 * Minorize-maximize iterations (Hunter 2004). Each entry also gets one win and one loss against a
 * virtual opponent of strength 1, so an entry that never lost stays finite and one-vote entries
 * stay near 1500 instead of flying to the extremes.
 */
export function fitBradleyTerry(tallies: PairTally[]): Map<number, number> {
  const wins = new Map<number, number>();
  const games = new Map<number, Map<number, number>>();
  const addGames = (a: number, b: number, n: number) => {
    let row = games.get(a);
    if (!row) games.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + n);
  };
  for (const { winnerEntryId: w, loserEntryId: l, votes } of tallies) {
    if (w === l || votes <= 0) continue;
    wins.set(w, (wins.get(w) ?? 0) + votes);
    if (!wins.has(l)) wins.set(l, 0);
    addGames(w, l, votes);
    addGames(l, w, votes);
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

  const meanLog =
    ids.reduce((sum, id) => sum + Math.log10(strength.get(id)!), 0) / (ids.length || 1);
  return new Map(
    ids.map((id) => [id, Math.round(ELO_BASE + 400 * (Math.log10(strength.get(id)!) - meanLog))])
  );
}

/**
 * When the fit, not Elo, ranks a crucible (display and prizes). Crucibles running at deploy finish
 * on Elo: switching mid-run would reorder a leaderboard judges have already seen. Set the date no
 * earlier than the deploy. To switch every crucible, return true; to switch none, set it to null.
 */
export const BRADLEY_TERRY_RANKING_FROM: Date | null = new Date('2026-11-06T00:00:00Z');

export function usesBradleyTerryRanking(crucible: { startAt: Date | null; createdAt: Date }) {
  if (!BRADLEY_TERRY_RANKING_FROM) return false;
  return (crucible.startAt ?? crucible.createdAt) >= BRADLEY_TERRY_RANKING_FROM;
}

/**
 * Every judge's votes in a crucible, one per judge and pair. ClickHouse holds about 1% repeated
 * rows, and a repeat never flips the winner, so any one row of the group stands for the vote.
 */
async function fetchDedupedTallies(crucibleId: number): Promise<PairTally[]> {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const rows = await clickhouse.$query<PairTally>`
    SELECT winnerEntryId, loserEntryId, toUInt32(count()) AS votes
    FROM (
      SELECT any(winnerEntryId) AS winnerEntryId, any(loserEntryId) AS loserEntryId
      FROM crucible_votes
      WHERE crucibleId = ${crucibleId}
      GROUP BY userId, least(winnerEntryId, loserEntryId), greatest(winnerEntryId, loserEntryId)
    )
    GROUP BY winnerEntryId, loserEntryId
  `;
  return rows.map((row) => ({
    winnerEntryId: Number(row.winnerEntryId),
    loserEntryId: Number(row.loserEntryId),
    votes: Number(row.votes),
  }));
}

/** For display: the fit over whatever ClickHouse holds now, lag and all. */
export async function fitCrucibleScores(crucibleId: number) {
  return fitBradleyTerry(await fetchDedupedTallies(crucibleId));
}

/** Pairs judged in this crucible as Redis counts them: the sum of every judge's voted-pairs set. */
async function countRedisJudgedPairs(crucibleId: number) {
  const judges = await sysRedis.sMembers(
    `${REDIS_SYS_KEYS.CRUCIBLE.JUDGES}:${crucibleId}` as RedisKeyTemplateSys
  );
  const counts = await Promise.all(
    (judges ?? []).map((userId) =>
      sysRedis.sCard(
        `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys
      )
    )
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fit prizes are paid from, or null to pay from Elo. Fits only once ClickHouse holds exactly
 * the votes Redis says were cast: fewer is ingest lag, so it re-reads a few times; more, or either
 * store unreachable, never converges and falls back. A judge set gone with its 30-day TTL also
 * falls back, by mismatch.
 */
export async function fitCrucibleScoresForPrizes(
  crucibleId: number,
  { attempts = 4, retryMs = 5_000 }: { attempts?: number; retryMs?: number } = {}
): Promise<Map<number, number> | null> {
  let clickhouseVotes = 0;
  let redisVotes = 0;
  try {
    redisVotes = await countRedisJudgedPairs(crucibleId);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const tallies = await fetchDedupedTallies(crucibleId);
      clickhouseVotes = tallies.reduce((sum, t) => sum + t.votes, 0);
      if (clickhouseVotes === redisVotes) return fitBradleyTerry(tallies);
      if (clickhouseVotes > redisVotes || attempt === attempts) break;
      await sleep(retryMs);
    }
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
