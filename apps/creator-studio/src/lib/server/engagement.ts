import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';

// Per-model engagement overview (feedback: alexds9) — comments + up/down votes across all of a creator's models
// so they can spot which ones are drawing downvotes/comments. All-time counts from ModelMetric (the daily rollup
// only tracks downloads, so there's no per-day votes/comments source). Scoped to models the creator actually needs
// to look at: those with at least one downvote or comment.
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
    .selectFrom('ModelMetric as mm')
    .innerJoin('Model as m', 'm.id', 'mm.modelId')
    .where('m.userId', '=', uid)
    .where('m.status', '=', 'Published')
    .where((eb) => eb.or([eb('mm.thumbsDownCount', '>', 0), eb('mm.commentCount', '>', 0)]))
    .select([
      'mm.modelId as modelId',
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
      comments: Number(r.comments),
      upvotes: Number(r.upvotes),
      downvotes: Number(r.downvotes),
    }))
    .sort((a, b) => b.downvotes - a.downvotes || b.comments - a.comments);
}

export const getModelEngagement = createCache({
  name: 'analytics:engagement',
  fetch: fetchModelEngagement,
  ttlSeconds: 3600,
}).get;
