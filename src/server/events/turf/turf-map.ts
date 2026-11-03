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
    // Image ids on someone's screen -> when that lapses (ms): which counts to push (turf-watch.ts).
    watch: `${root}:watch` as const,
  };
}

// One image's live counts. Image ids are public and so is what this carries, so no keyed id.
export const eventTurfTopic = (event: string, imageId: number) =>
  `${SignalTopic.EventPoints}:${event}:turf:${imageId}` as const;

/** The leading team on a turf image and the stickerers an action there credits. */
export type TurfEntry = {
  team: string;
  // The team's join cosmetic: the ledger names a turf credit as (player, this, 'turf').
  cosmeticId: number;
  // The leading team's earliest eligible stickerers, at most the credited cap in force.
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
  creditedPlayers: number,
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
    .slice(0, creditedPlayers)
    .map((r) => r.userId);
  const lastAt = Math.max(...rows.map((r) => r.createdAt.getTime()));
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
