import { clickhouse } from '~/server/clickhouse/client';
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

function getBradleyTerryKey(crucibleId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.BRADLEY_TERRY}:${crucibleId}` as RedisKeyTemplateSys;
}

const BRADLEY_TERRY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Refits one crucible from every vote in ClickHouse and stores the scores in Redis. Shadow only for
 * now: nothing reads them for display or prizes yet, the live Elo stays the ranking.
 * @returns how many entries were scored, or null when ClickHouse is not configured
 */
export async function refitCrucibleBradleyTerry(crucibleId: number): Promise<number | null> {
  if (!clickhouse) return null;
  const tallies = await clickhouse.$query<PairTally>`
    SELECT winnerEntryId, loserEntryId, toUInt32(count()) AS votes
    FROM crucible_votes
    WHERE crucibleId = ${crucibleId}
    GROUP BY winnerEntryId, loserEntryId
  `;
  const scores = fitBradleyTerry(
    tallies.map((t) => ({
      winnerEntryId: Number(t.winnerEntryId),
      loserEntryId: Number(t.loserEntryId),
      votes: Number(t.votes),
    }))
  );
  if (!scores.size) return 0;

  const key = getBradleyTerryKey(crucibleId);
  await sysRedis.del(key);
  await sysRedis.hSet(
    key,
    Object.fromEntries([...scores].map(([id, score]) => [String(id), String(score)]))
  );
  await sysRedis.expire(key, BRADLEY_TERRY_TTL_SECONDS);
  return scores.size;
}
