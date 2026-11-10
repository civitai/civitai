import { SignalTopic } from '~/server/common/enums';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';

// Which team holds each turf image and whom an action on it credits. Built from the live stickers
// (turf.service.ts), held in sysRedis, and followed into every app server's memory like the hat map,
// so the view hot path never reads the database.

export function turfKeys(event: string) {
  const root = `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:turf` as const;
  return {
    // `Image:{id}` -> TurfEntry, only for images with a leader.
    map: `${root}:map` as const,
    // Stream of changes to `map` (k = entity key, v = encoded entry, '' when it lost its leader).
    log: `${root}:map-log` as const,
    // `Image:{id}` -> TurfCounts, for every image with a live sticker. Display only.
    counts: `${root}:counts` as const,
    // A ticket each sync or reconcile batch takes before its read: a higher ticket read later.
    // Reset only with `stamp`: alone, every later write would fall below the stored stamps.
    seq: `${root}:seq` as const,
    // `Image:{id}` -> the ticket of the read last written for it, so an older read never overwrites a
    // newer one. Kept after an image empties: deleting it would let a stale read write the image back.
    stamp: `${root}:stamp` as const,
    // Image ids on someone's screen -> when that lapses (ms): which counts to push (turf-watch.ts).
    watch: `${root}:watch` as const,
    // Image ids showing any live sticker, contest entries left out: the feed's "Turf hats" filter.
    hatted: `${root}:hatted` as const,
    // Image id -> turfRankScore of its counted stickers, all teams: the "Most / Fewest hats" sorts.
    rankTotal: `${root}:rank:total` as const,
    // The same for one team's counted stickers.
    rankTeam: (team: string) => `${root}:rank:team:${team}` as const,
    // Several teams' ranks summed, rebuilt when it lapses (turf-feed.ts).
    rankUnion: (teams: string[]) => `${root}:rank:union:${teams.join('+')}` as const,
  };
}

// Hats times 2^34 plus the image id: one image per score, ties on hats broken by id, and a union
// of up to four team ranks adds at most 4 ids (under 2^33), never reaching the hats part.
// Exact while hats < 2^19 and ids < 2^31.
const RANK_HATS_UNIT = 2 ** 34;
export const turfRankScore = (hats: number, imageId: number) => hats * RANK_HATS_UNIT + imageId;
/** The lowest score an image with at least one counted sticker has. */
export const TURF_RANK_MIN = RANK_HATS_UNIT;

// One image's live counts. Image ids are public and so is what this carries, so no keyed id.
export const eventTurfTopic = (event: string, imageId: number) =>
  `${SignalTopic.EventPoints}:${event}:turf:${imageId}` as const;

/** The leading team on a turf image and the stickerers an action there credits. */
export type TurfEntry = {
  team: string;
  // The team's join cosmetic: the ledger names a turf credit as (player, this, 'turf').
  cosmeticId: number;
  // The leading team's earliest eligible stickerers, at most that team's credited cap in force.
  players: number[];
  // When the newest live sticker went on; the map keeps the most recent images when full.
  lastAt: number;
};

export type TurfCounts = {
  // Live stickers per team, eligible or not: what the image shows.
  shown: Record<string, number>;
  // Eligible stickers per team: what decides the lead.
  counted: Record<string, number>;
  leader: string | null;
  // The art of the leading team's first counted sticker: what a card draws as the image's badge.
  leaderCosmeticId: number | null;
};

export type TurfStickerRow = {
  userId: number;
  team: string;
  // The hat the sticker shows.
  cosmeticId: number;
  // The placer may earn: an account from before the event start, or one at the required tier.
  eligible: boolean;
  createdAt: Date;
};

export const TURF_CLAIM_KEY = 'turf';

/**
 * One image's counts and entry from its live stickers, oldest first. The lead goes to the team with
 * the most eligible stickers; between teams level on that count, to the one that reached it first.
 * Ineligible stickers show but never count, so throwaway accounts cannot move turf.
 */
export function computeImageTurf(
  rows: readonly TurfStickerRow[],
  // How many stickerers an action credits on an image the team leads (turfCreditedByTeam).
  creditedPlayers: (team: string) => number,
  teamCosmetic: (team: string) => number | undefined
): { counts: TurfCounts; entry: TurfEntry | null } {
  const shown: Record<string, number> = {};
  const counted: Record<string, number> = {};
  // Position of each team's latest eligible sticker: when it reached its current count.
  const reachedAt: Record<string, number> = {};
  rows.forEach((r, i) => {
    shown[r.team] = (shown[r.team] ?? 0) + 1;
    if (!r.eligible) return;
    counted[r.team] = (counted[r.team] ?? 0) + 1;
    reachedAt[r.team] = i;
  });
  let leader: string | null = null;
  for (const [team, n] of Object.entries(counted)) {
    const best = leader ? counted[leader] : 0;
    if (n > best || (n === best && reachedAt[team] < reachedAt[leader!])) leader = team;
  }
  const leaderCosmeticId = rows.find((r) => r.eligible && r.team === leader)?.cosmeticId ?? null;
  const counts = { shown, counted, leader, leaderCosmeticId };
  const cosmeticId = leader ? teamCosmetic(leader) : undefined;
  if (!leader || !cosmeticId) return { counts, entry: null };
  const players = rows
    .filter((r) => r.eligible && r.team === leader)
    .slice(0, creditedPlayers(leader))
    .map((r) => r.userId);
  // Not Math.max(...rows): spreading past ~125k arguments overflows the stack on a busy image.
  const lastAt = rows.reduce((max, r) => Math.max(max, r.createdAt.getTime()), 0);
  return { counts, entry: { team: leader, cosmeticId, players, lastAt } };
}

export const encodeTurfEntry = (entry: TurfEntry) => JSON.stringify(entry);
export function decodeTurfEntry(value: string): TurfEntry | undefined {
  try {
    const e = JSON.parse(value) as Partial<TurfEntry>;
    if (!e.team || !e.cosmeticId || !Array.isArray(e.players) || !e.players.length)
      return undefined;
    if (!e.players.every((p) => Number.isInteger(p) && p > 0)) return undefined;
    return { team: e.team, cosmeticId: e.cosmeticId, players: e.players, lastAt: e.lastAt ?? 0 };
  } catch {
    return undefined;
  }
}

/** The entries to keep when there are more than `max`: the most recently stickered. */
export function capTurfMap(entries: Map<string, TurfEntry>, max: number) {
  if (entries.size <= max) return { kept: entries, dropped: 0 };
  const sorted = [...entries].sort(([, a], [, b]) => b.lastAt - a.lastAt);
  return { kept: new Map(sorted.slice(0, max)), dropped: entries.size - max };
}
