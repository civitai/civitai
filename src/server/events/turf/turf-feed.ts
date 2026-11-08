import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';
import { dbRead } from '~/server/db/client';
import { flagAudienceAmong } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { logToAxiom } from '~/server/logging/client';
import { eventPointKeys } from '~/server/events/points/keys';
import { TURF_RANK_MIN, turfKeys } from '~/server/events/turf/turf-map';
import { getTurfEvent, inTurf, isRunning, type TurfEvent } from '~/server/events/turf/turf.service';
import { sysRedis } from '~/server/redis/client';
import type { HatSort } from '~/shared/constants/hat-turf-feed.constants';

// The image feed's Hat Turf sorts and Show filters, read from the indexes WRITE_TURF_SCRIPT keeps.

// Who plays, per server, for a minute: a viewer who stopped playing still sends the fields saved
// in their filters on every feed page, and each would otherwise cost a lookup.
const PLAYER_TTL_MS = 60_000;
const PLAYER_CACHE_MAX = 50_000;
const players = new Map<number, { at: number; event: TurfEvent | null }>();

/**
 * The running turf event `userId` plays in the feed, or null: event cosmetics not turned off, and
 * opted in to Hat Turf (inTurf). In shadow mode, only its testers. The feed shows nothing of the
 * sorts or filters to anyone else and ignores them on the wire. A failed lookup is null, never an
 * error: the feed must not fail for a field it would ignore.
 */
export async function getHatTurfFeedEvent(
  userId: number | undefined,
  now = new Date()
): Promise<TurfEvent | null> {
  if (!userId) return null;
  const cached = players.get(userId);
  if (cached && now.getTime() - cached.at < PLAYER_TTL_MS) return cached.event;
  let event: TurfEvent | null;
  try {
    event = await findPlayerEvent(userId, now);
  } catch (error) {
    void logToAxiom({
      type: 'warning',
      name: 'event-turf',
      message: 'feed player lookup failed',
      error: (error as Error).message,
    });
    return null;
  }
  if (players.size >= PLAYER_CACHE_MAX) players.clear();
  players.set(userId, { at: now.getTime(), event });
  return event;
}

async function findPlayerEvent(userId: number, now: Date) {
  for (const def of await loadEvents()) {
    if (!def.turf) continue;
    const event = await getTurfEvent(def.name, now);
    if (!event || !isRunning(event, now)) continue;
    if (event.turf.mode === 'shadow') {
      const testers = await flagAudienceAmong(event.turf.testerFlag, [userId]);
      if (!testers.has(userId)) continue;
    }
    const [row] = await dbRead.$queryRaw<{ player: boolean }[]>`
      SELECT (${inTurf('u', event.name)})
        AND (u.settings ->> 'showEventCosmetics') IS DISTINCT FROM 'false' AS player
      FROM "User" u WHERE u.id = ${userId}
    `;
    if (row?.player) return event;
  }
  return null;
}

// How long a sum of several teams' ranks is reused before it is built again.
const RANK_UNION_TTL_MS = 30_000;
// Read past the page so images tied on the cursor's score, dropped as already served, leave a page.
const RANK_TIE_SLACK = 8;

// KEYS: one rank, or several to sum and then the key that holds the sum. ARGV: min, max, '1' for
// highest first, count, the sum's ttl (ms). Returns member, score pairs.
const READ_RANK_SCRIPT = `
local src = KEYS[1]
if #KEYS > 1 then
  src = KEYS[#KEYS]
  if redis.call('EXISTS', src) == 0 then
    local args = { src, tostring(#KEYS - 1) }
    for i = 1, #KEYS - 1 do args[#args + 1] = KEYS[i] end
    redis.call('ZUNIONSTORE', unpack(args))
    redis.call('PEXPIRE', src, ARGV[5])
  end
end
if ARGV[3] == '1' then
  return redis.call('ZRANGE', src, ARGV[2], ARGV[1], 'BYSCORE', 'REV', 'LIMIT', '0', ARGV[4], 'WITHSCORES')
end
return redis.call('ZRANGE', src, ARGV[1], ARGV[2], 'BYSCORE', 'LIMIT', '0', ARGV[4], 'WITHSCORES')`;

const CURSOR = /^(\d+)\|(\d+)$/;

/**
 * One page of image ids by hats: `most` highest first, `fewest` lowest first (from one counted hat).
 * `teams` picks whose hats count (none: every team's). The cursor is `score|id` of the last id served;
 * a cursor of another shape starts from the top.
 */
export async function readTurfRankPage({
  event,
  sort,
  teams,
  cursor,
  limit,
}: {
  event: TurfEvent;
  sort: HatSort;
  teams?: string[];
  cursor?: string;
  limit: number;
}) {
  const keys = turfKeys(event.name);
  const picked = event.teams.filter((t) => teams?.some((x) => x.toLowerCase() === t.toLowerCase()));
  const ranks = picked.length ? picked.map((t) => keys.rankTeam(t)) : [keys.rankTotal];
  const match = cursor ? CURSOR.exec(cursor) : null;
  const at = match ? { score: Number(match[1]), member: match[2] } : null;
  const most = sort === 'most';
  // Inclusive of the cursor's score, so an image tied on it is not skipped.
  const min = String(!most && at ? at.score : TURF_RANK_MIN);
  const max = most && at ? String(at.score) : '+inf';
  const count = limit + RANK_TIE_SLACK;
  const reply = (await sysRedis.eval(READ_RANK_SCRIPT, {
    keys: ranks.length > 1 ? [...ranks, keys.rankUnion(picked)] : ranks,
    arguments: [min, max, most ? '1' : '', String(count), String(RANK_UNION_TTL_MS)],
  })) as unknown[];
  // The HA client may hand back Buffers.
  const flat = reply.map(String);
  const rows: { member: string; score: number }[] = [];
  for (let i = 0; i < flat.length; i += 2)
    rows.push({ member: flat[i], score: Number(flat[i + 1]) });
  // Redis orders a tie by member bytes, reversed under REV; those up to the cursor were served.
  const fresh = at
    ? rows.filter(
        (r) => r.score !== at.score || (most ? r.member < at.member : r.member > at.member)
      )
    : rows;
  const page = fresh.slice(0, limit);
  const more = fresh.length > limit || rows.length === count;
  const last = page[page.length - 1] ?? rows[rows.length - 1];
  return {
    ids: page.map((r) => Number(r.member)),
    nextCursor: more && last ? `${last.score}|${last.member}` : undefined,
  };
}

/**
 * Which of `ids` the Show filters hide: `turf` hides an image showing any live Turf hat (contest
 * entries show none, so never), `worn` one wearing its owner's event hat.
 */
export async function turfHiddenIds(
  event: TurfEvent,
  ids: number[],
  hide: { turf?: boolean; worn?: boolean }
) {
  const hidden = new Set<number>();
  if (!ids.length || (!hide.turf && !hide.worn)) return hidden;
  let hatted: unknown[] | null, worn: unknown[] | null;
  try {
    [hatted, worn] = await Promise.all([
      hide.turf ? sysRedis.smIsMember(turfKeys(event.name).hatted, ids.map(String)) : null,
      hide.worn
        ? sysRedis.hmGet(
            eventPointKeys(event.name).hats,
            ids.map((id) => `Image:${id}`)
          )
        : null,
    ]);
  } catch (error) {
    // A preference, not a gate: on a failed read show everything rather than fail the feed.
    void logToAxiom({
      type: 'warning',
      name: 'event-turf',
      message: 'feed show filter failed',
      error: (error as Error).message,
    });
    return hidden;
  }
  ids.forEach((id, i) => {
    if (hatted?.[i] || worn?.[i]) hidden.add(id);
  });
  return hidden;
}

// How many reads a Hat Turf page may take to fill before it is returned short, with its cursor.
export const TURF_FEED_MAX_READS = 3;

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTurfFeedMetrics: { pages: client.Counter<string> } | undefined;
}
const metrics =
  globalThis.__civitaiTurfFeedMetrics ??
  (globalThis.__civitaiTurfFeedMetrics = {
    pages: new client.Counter({
      name: PROM_PREFIX + 'turf_feed_pages_total',
      help:
        'Image feed pages served under a Hat Turf sort (`mode=sort`) or Show filter (`mode=show`), ' +
        'by how they came back after up to 3 reads: `full`, `end` (the feed ran out), `short` (fewer ' +
        'than asked, more to come) or `empty` (none, more to come), and `reads` taken. A high short ' +
        'or empty share means the filters thin pages.',
      labelNames: ['mode', 'outcome', 'reads'],
    }),
  });

/**
 * Reads pages until `limit` items survive `keep`, or `TURF_FEED_MAX_READS` reads, or the feed ends.
 * Every read continues from the last one's cursor, so the returned cursor follows the last read.
 */
export async function fillTurfPage<T extends { id: number }, R extends { items: T[] }, C>(
  mode: 'sort' | 'show',
  limit: number,
  cursor: C | undefined,
  read: (cursor: C | undefined) => Promise<R & { nextCursor?: C }>,
  keep: (items: T[]) => Promise<T[]> = async (items) => items
): Promise<R & { nextCursor?: C }> {
  const items: T[] = [];
  let reads = 0;
  let result: R & { nextCursor?: C };
  do {
    result = await read(cursor);
    reads++;
    items.push(...(await keep(result.items)));
    cursor = result.nextCursor;
  } while (items.length < limit && cursor !== undefined && reads < TURF_FEED_MAX_READS);
  const outcome =
    items.length >= limit
      ? 'full'
      : cursor === undefined
      ? 'end'
      : items.length
      ? 'short'
      : 'empty';
  metrics.pages.inc({ mode, outcome, reads: String(reads) });
  return { ...result, items };
}
