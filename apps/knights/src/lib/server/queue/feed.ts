import { NsfwLevel } from '@civitai/shared';

/** How the feed picks what to serve. Product rules, kept in one place. */
export const FEED = {
  /** Candidates read per stage; the pick is made among these. */
  windowSize: 40,
  /** After moving up a stage an item is served ahead of normal priority for this long, then ordered normally. */
  escalationPriorityHours: 24,
  /** How many of the player's latest judged items the next pick tries to differ from. */
  recentJudged: 3,
  /** Share of picks that take the oldest candidate instead of the mixed pick, so no item waits behind the mix forever. */
  starvationShare: 0.1,
} as const;

/** Source priority, best first: escalated items while their priority lasts, then the item's own priority. */
export const TIER_ESCALATED = 0;
export const TIER_NORMAL = 1;

export type LevelBucket = 'PG' | 'PG-13' | 'R' | 'X' | 'XXX';

const BUCKETS: [number, LevelBucket][] = [
  [NsfwLevel.PG, 'PG'],
  [NsfwLevel.PG13, 'PG-13'],
  [NsfwLevel.R, 'R'],
  [NsfwLevel.X, 'X'],
  [NsfwLevel.XXX, 'XXX'],
];

/** The bucket of a level flag; Blocked, unrated and unknown values have none. */
export const levelBucket = (level: number): LevelBucket | null =>
  BUCKETS.find(([flag]) => flag === level)?.[1] ?? null;

/**
 * The bucket an item is mixed by: the level the producing model expects (`prediction.value`) when it names one,
 * else the image's current level.
 */
export function itemBucket(prediction: unknown, imageLevel: number): LevelBucket | null {
  const predicted =
    prediction && typeof prediction === 'object' && 'value' in prediction
      ? levelBucket(Number((prediction as { value: unknown }).value))
      : null;
  return predicted ?? levelBucket(imageLevel);
}

/** FNV-1a over `playerId:itemId`: a stable order that differs from player to player. */
export function tieBreak(playerId: number, itemId: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${playerId}:${itemId}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash;
}

/** An item escalated inside the priority window is read by both windows; keep its lowest (best) tier, whatever the row order. */
export function lowestTierPerItem<T extends { id: number; tier: number }>(rows: T[]): T[] {
  const best = new Map<number, T>();
  for (const row of rows) {
    const kept = best.get(row.id);
    if (!kept || row.tier < kept.tier) best.set(row.id, row);
  }
  return [...best.values()];
}

export type FeedCandidate = {
  id: number;
  tier: number;
  priority: number;
  /** Epoch milliseconds. */
  createdAt: number;
  bucket: LevelBucket | null;
};

const byAge = (a: FeedCandidate, b: FeedCandidate) => a.createdAt - b.createdAt || a.id - b.id;

/**
 * Orders a stage's window for one player. Candidates must already be in serving order (tier, priority, age). Each pick is
 * normally the first candidate of the leading tier and priority, in the player's own order, whose bucket is not among
 * the player's recent ones, else the first; about one pick in ten takes the oldest candidate of the whole window.
 */
export function orderFeed<T extends FeedCandidate>(
  candidates: T[],
  input: {
    playerId: number;
    recent: (LevelBucket | null)[];
    random: () => number;
    limit: number;
  }
): T[] {
  const pool = [...candidates];
  const recent = [...input.recent];
  const served: T[] = [];

  while (served.length < input.limit && pool.length > 0) {
    let pick: T;
    if (input.random() < FEED.starvationShare) {
      pick = [...pool].sort(byAge)[0];
    } else {
      const lead = pool[0];
      const leading = pool
        .filter((c) => c.tier === lead.tier && c.priority === lead.priority)
        .sort((a, b) => tieBreak(input.playerId, a.id) - tieBreak(input.playerId, b.id));
      pick = leading.find((c) => c.bucket === null || !recent.includes(c.bucket)) ?? leading[0];
    }
    pool.splice(pool.indexOf(pick), 1);
    served.push(pick);
    recent.unshift(pick.bucket);
    recent.length = Math.min(recent.length, FEED.recentJudged);
  }
  return served;
}
