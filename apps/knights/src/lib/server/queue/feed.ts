import { NsfwLevel } from '@civitai/shared';

/** How the feed picks what to serve. Product rules, kept in one place. */
export const FEED = {
  /** Candidates read per level bucket per stage (escalated items: this times the bucket count, in one read); the pick is made among these. */
  bucketWindowSize: 10,
  /** After moving up a stage an item is served ahead of normal priority for this long, then ordered normally. */
  escalationPriorityHours: 24,
  /** How many of the player's latest judged items the next pick tries to differ from. */
  recentJudged: 3,
  /** Only judgments this recent count toward `recentJudged`; the bound also keeps the read on the newest ledger partitions. */
  recentJudgedHours: 24,
  /** Share of picks that take the oldest candidate of the chosen bucket instead of its lead, so no item waits forever. */
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

/** The level flags that have a bucket, in bucket order. */
export const BUCKET_LEVELS: readonly number[] = BUCKETS.map(([flag]) => flag);

/** The bucket of a level flag; Blocked, unrated and unknown values have none. */
export const levelBucket = (level: number): LevelBucket | null =>
  BUCKETS.find(([flag]) => flag === level)?.[1] ?? null;

/**
 * The bucket an item is mixed by: the level the producing model expects (`prediction.value`, a number or a plain
 * integer string) when it names one, else the image's current level. `bucketLevelSql` in `queue.service.ts` is the
 * same rule for the window read; a test pins the two agreeing.
 */
export function itemBucket(prediction: unknown, imageLevel: number): LevelBucket | null {
  const value =
    prediction && typeof prediction === 'object' && 'value' in prediction
      ? (prediction as { value: unknown }).value
      : undefined;
  const predicted =
    typeof value === 'number'
      ? levelBucket(value)
      : typeof value === 'string' && String(Number(value)) === value
      ? levelBucket(Number(value))
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

/** Buckets in a fixed order (null last), so the draw does not depend on row order. */
const BUCKET_ORDER: (LevelBucket | null)[] = [...BUCKETS.map(([, bucket]) => bucket), null];

/**
 * Orders a stage's window for one player. Candidates must already be in serving order (tier, priority, age). Each pick
 * draws a bucket with equal probability among the buckets that still have candidates, leaving out the player's recent
 * buckets unless that leaves none. Within the bucket it takes the first candidate
 * of the leading tier and priority in the player's own order; about one pick in ten takes the bucket's oldest instead.
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
  const pools = new Map<LevelBucket | null, T[]>();
  for (const bucket of BUCKET_ORDER) {
    const pool = candidates.filter((c) => c.bucket === bucket);
    if (pool.length > 0) pools.set(bucket, pool);
  }
  const recent = [...input.recent];
  const served: T[] = [];

  while (served.length < input.limit && pools.size > 0) {
    const open = [...pools.keys()];
    const fresh = open.filter((b) => !recent.includes(b));
    const choices = fresh.length > 0 ? fresh : open;
    const bucket =
      choices[Math.min(choices.length - 1, Math.floor(input.random() * choices.length))];
    const pool = pools.get(bucket) as T[];

    let pick: T;
    if (input.random() < FEED.starvationShare) {
      pick = [...pool].sort(byAge)[0];
    } else {
      const lead = pool[0];
      pick = pool
        .filter((c) => c.tier === lead.tier && c.priority === lead.priority)
        .sort((a, b) => tieBreak(input.playerId, a.id) - tieBreak(input.playerId, b.id))[0];
    }
    pool.splice(pool.indexOf(pick), 1);
    if (pool.length === 0) pools.delete(bucket);
    served.push(pick);
    recent.unshift(pick.bucket);
    recent.length = Math.min(recent.length, FEED.recentJudged);
  }
  return served;
}
