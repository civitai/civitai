import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getClickhouse } from '$lib/server/clickhouse';
import { getLogger } from '$lib/server/logger';
import { safeError } from '@civitai/axiom';

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
  /** Position in the Hot feed's universe on `hotRankDay`, before per-viewer filters. Null: not ranked that day. */
  hotRank: number | null;
};

export type ModelEngagementList = {
  models: ModelEngagement[];
  /** The latest complete nightly Hot rank snapshot (YYYY-MM-DD, UTC). Null: none, or ClickHouse unavailable. */
  hotRankDay: string | null;
};

// Snapshot written nightly by src/server/jobs/model-hot-rank-snapshot.ts; a day counts once it has a runs row.
// Only the creator's own model ids are read, and only rank (the table also carries poi/minor flags).
const ID_CHUNK = 5000;

async function fetchHotRanks(
  modelIds: number[]
): Promise<{ day: string | null; ranks: Map<number, number> }> {
  const ch = getClickhouse();
  const [latest] = await ch.$query<{ day: string }>(
    `SELECT toString(day) AS day FROM default.model_hot_rank_runs ORDER BY day DESC LIMIT 1`
  );
  const day = latest?.day;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { day: null, ranks: new Map() };

  const ids = modelIds.filter(Number.isInteger);
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
  return { day, ranks: new Map(results.flat().map((r) => [Number(r.modelId), Number(r.rank)])) };
}

async function fetchModelEngagement({ userId }: { userId: number }): Promise<ModelEngagementList> {
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
  const modelIds = rows.map((r) => Number(r.modelId));
  // A missing rank column must not take the engagement list down with it.
  const hot = modelIds.length
    ? await fetchHotRanks(modelIds).catch((error) => {
        getLogger().logToAxiom({
          name: 'engagement-hot-rank-unavailable',
          error: safeError(error),
        });
        return { day: null, ranks: new Map<number, number>() };
      })
    : { day: null, ranks: new Map<number, number>() };
  const models = rows
    .map((r) => ({
      modelId: Number(r.modelId),
      name: r.name ?? null,
      nsfw: !!r.nsfw,
      nsfwLevel: Number(r.nsfwLevel),
      comments: Number(r.comments ?? 0),
      upvotes: Number(r.upvotes ?? 0),
      downvotes: Number(r.downvotes ?? 0),
      hotRank: hot.ranks.get(Number(r.modelId)) ?? null,
    }))
    .sort((a, b) => b.downvotes - a.downvotes || b.comments - a.comments);
  return { models, hotRankDay: hot.day };
}

// Bump the cache name when the cached list's filter or shape changes, or old entries are served until the TTL expires.
export const getModelEngagement = createCache({
  name: 'analytics:engagement:v3',
  fetch: fetchModelEngagement,
  ttlSeconds: 3600,
}).get;
