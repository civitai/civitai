import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getClickhouse } from '$lib/server/clickhouse';

// Per-model engagement overview (feedback: alexds9) — comments + up/down votes across all of a creator's models
// so they can spot which ones are drawing downvotes/comments. All-time counts from ModelMetric (the daily rollup
// only tracks downloads, so there's no per-day votes/comments source).
export type ModelEngagement = {
  modelId: number;
  name: string | null;
  nsfw: boolean;
  nsfwLevel: number;
  comments: number;
  upvotes: number;
  downvotes: number;
};

async function fetchModelEngagement({ userId }: { userId: number }): Promise<ModelEngagement[]> {
  const uid = Number(userId);
  const rows = await dbRead
    .selectFrom('Model as m')
    .leftJoin('ModelMetric as mm', 'mm.modelId', 'm.id')
    .where('m.userId', '=', uid)
    .where('m.status', '=', 'Published')
    .select([
      'm.id as modelId',
      'm.name as name',
      'm.nsfw as nsfw',
      'm.nsfwLevel as nsfwLevel',
      'mm.commentCount as comments',
      'mm.thumbsUpCount as upvotes',
      'mm.thumbsDownCount as downvotes',
    ])
    .execute();
  return rows
    .map((r) => ({
      modelId: Number(r.modelId),
      name: r.name ?? null,
      nsfw: !!r.nsfw,
      nsfwLevel: Number(r.nsfwLevel),
      comments: Number(r.comments ?? 0),
      upvotes: Number(r.upvotes ?? 0),
      downvotes: Number(r.downvotes ?? 0),
    }))
    .sort((a, b) => b.downvotes - a.downvotes || b.comments - a.comments);
}

// Bump the cache name when the cached list's filter or shape changes, or old entries are served until the TTL expires.
export const getModelEngagement = createCache({
  name: 'analytics:engagement:v2',
  fetch: fetchModelEngagement,
  ttlSeconds: 3600,
}).get;

// Hot rank per model, from the nightly snapshot written by src/server/jobs/model-hot-rank-snapshot.ts.
// Cached apart from the list above, and a failure throws instead of returning empty, so a ClickHouse
// blip is never cached as "no rank" for the TTL. A day counts only once it has a runs row.
// Only the creator's own model ids are read, and only rank: the table also carries poi/minor flags.
export type HotRanks = {
  /** The latest complete snapshot day (YYYY-MM-DD, UTC); null when no day is complete yet. */
  day: string | null;
  /** modelId → position in the Hot feed's universe that day, before per-viewer filters. */
  ranks: Record<number, number>;
};

const ID_CHUNK = 5000;

async function fetchHotRanks({ userId }: { userId: number }): Promise<HotRanks> {
  const ch = getClickhouse();
  const [latest] = await ch.$query<{ day: string }>(
    `SELECT toString(day) AS day FROM default.model_hot_rank_runs ORDER BY day DESC LIMIT 1`
  );
  const day = latest?.day;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { day: null, ranks: {} };

  const models = await dbRead
    .selectFrom('Model')
    .where('userId', '=', Number(userId))
    .where('status', '=', 'Published')
    .select('id')
    .execute();
  const ids = models.map((m) => Number(m.id)).filter(Number.isInteger);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      ch.$query<{ modelId: number | string; rank: number | string }>(
        `SELECT modelId, rank FROM default.model_hot_rank_daily
         WHERE day = toDate('${day}') AND modelId IN (${chunk.join(',')})`
      )
    )
  );
  return {
    day,
    ranks: Object.fromEntries(results.flat().map((r) => [Number(r.modelId), Number(r.rank)])),
  };
}

export const getHotRanks = createCache({
  name: 'analytics:engagement-hot-rank:v1',
  fetch: fetchHotRanks,
  ttlSeconds: 3600,
}).get;

/**
 * "as of last night" only while the newest day is the latest run due: today's once the 04:20 UTC run
 * has had until 06:00 to finish, yesterday's before that. Otherwise the date, so a missed night shows.
 */
export function hotRankAsOf(day: string | null, now = new Date()): string | null {
  if (!day) return null;
  const due = new Date(now.getTime() - 6 * 3_600_000).toISOString().slice(0, 10);
  return day >= due ? 'as of last night' : `as of ${day}`;
}
