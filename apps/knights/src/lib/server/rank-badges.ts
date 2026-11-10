import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { imageUrl } from './image-url';
import { RANK_BADGE_IDS } from './progression/badges';

/**
 * The rank badge cosmetics the pages show. Acolyte is added here rather than in `RANK_BADGE_IDS` because that also says
 * which badges a rank-up grants, and the Acolyte badge is not granted here.
 */
export const RANK_BADGE_COSMETICS = { Acolyte: 858, ...RANK_BADGE_IDS } as const;

type CosmeticRow = { id: number; data: unknown };

/** Rank to the image key of its badge. A rank whose cosmetic is missing, or has no url, is absent. */
export function badgeKeysFrom(rows: CosmeticRow[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [rank, id] of Object.entries(RANK_BADGE_COSMETICS)) {
    const url = (rows.find((row) => row.id === id)?.data as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && url) keys[rank] = url;
  }
  return keys;
}

export type RankBadgeUrls = { small: Record<string, string>; large: Record<string, string> };

const SMALL_PX = 48;
const LARGE_PX = 450;
const TTL_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
let held: { at: number; urls: RankBadgeUrls } | undefined;
let failedAt: number | undefined;
const EMPTY = (): RankBadgeUrls => ({ small: {}, large: {} });

/**
 * Badge image addresses at two sizes, resolved the way the leaderboard does (a Trophy cosmetic's `data.url` key through
 * the CDN). Held in this process for ten minutes since cosmetics rarely change, and never throws: on a failed read the
 * pages show the crest (or the last urls read), and the read is not retried for a minute so a degraded database is not hit
 * by every page load.
 */
export async function rankBadgeUrls(db: Kysely<DB>, now = Date.now()): Promise<RankBadgeUrls> {
  if (held && now - held.at < TTL_MS) return held.urls;
  if (failedAt !== undefined && now - failedAt < FAILURE_BACKOFF_MS) return held?.urls ?? EMPTY();
  try {
    const rows = await db
      .selectFrom('Cosmetic')
      .select(['id', 'data'])
      .where('id', 'in', Object.values(RANK_BADGE_COSMETICS))
      .where('source', '=', 'Trophy')
      .execute();
    const keys = badgeKeysFrom(rows);
    const urls: RankBadgeUrls = { small: {}, large: {} };
    for (const [rank, key] of Object.entries(keys)) {
      urls.small[rank] = imageUrl(key, SMALL_PX);
      urls.large[rank] = imageUrl(key, LARGE_PX);
    }
    held = { at: now, urls };
    failedAt = undefined;
    return urls;
  } catch (error) {
    console.error('knights: could not read the rank badges', { error });
    failedAt = now;
    return held?.urls ?? EMPTY();
  }
}
