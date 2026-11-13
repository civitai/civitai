import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';

// Per-model engagement overview (feedback: alexds9) — comments + up/down votes across all of a creator's models
// so they can spot which ones are drawing downvotes/comments. All-time counts from ModelMetric (the daily rollup
// only tracks downloads, so there's no per-day votes/comments source). Lists every published model; one with no
// ModelMetric row yet shows zeros. Models drawing downvotes/comments sort first.
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

// v2: the list grew from "models with votes or comments" to every published model; v1 entries hold the old subset.
export const getModelEngagement = createCache({
  name: 'analytics:engagement:v2',
  fetch: fetchModelEngagement,
  ttlSeconds: 3600,
}).get;
