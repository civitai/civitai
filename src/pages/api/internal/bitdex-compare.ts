import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getImagesFromSearchPreFilter,
  getImagesFromBitdexPreFilter,
} from '~/server/services/image.service';
import { ImageSort } from '~/server/common/enums';

/**
 * BitDex vs Meilisearch comparison endpoint.
 *
 * Calls getImagesFromSearchPreFilter (real Meili path) and
 * getImagesFromBitdexPreFilter (native BitDex path) with the same
 * input, returning both result sets for comparison.
 *
 * GET /api/internal/bitdex-compare?sort=Newest&browsingLevel=1&limit=20
 * GET /api/internal/bitdex-compare?sort=MostReactions&browsingLevel=1&limit=20&cursor=20|1772150400000
 */
export default PublicEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const q = req.query;

  const limit = Number(q.limit) || 20;
  const browsingLevel = Number(q.browsingLevel) || 1;

  const sortMap: Record<string, ImageSort> = {
    Newest: ImageSort.Newest,
    Oldest: ImageSort.Oldest,
    MostReactions: ImageSort.MostReactions,
    MostComments: ImageSort.MostComments,
    MostCollected: ImageSort.MostCollected,
  };
  const sort = sortMap[q.sort as string] ?? ImageSort.Newest;

  // Parse cursor → offset + entry
  const cursorParsed = q.cursor?.toString().split('|');
  const offset = cursorParsed?.[0] ? Number(cursorParsed[0]) : 0;
  const entry = cursorParsed?.[1] ? Number(cursorParsed[1]) : undefined;

  // Shared input for both paths
  const input: any = {
    sort,
    limit,
    browsingLevel,
    include: [],
    offset,
    entry,
    ...(q.types && { types: (q.types as string).split(',') }),
    ...(q.userId && { userId: Number(q.userId) }),
    ...(q.tags && { tags: (q.tags as string).split(',').map(Number) }),
    ...(q.withMeta === 'true' && { withMeta: true }),
    ...(q.fromPlatform === 'true' && { fromPlatform: true }),
    ...(q.postId && { postId: Number(q.postId) }),
    ...(q.modelVersionId && { modelVersionId: Number(q.modelVersionId) }),
    ...(q.baseModels && { baseModels: (q.baseModels as string).split(',') }),
    ...(q.excludedTagIds && { excludedTagIds: (q.excludedTagIds as string).split(',').map(Number) }),
    ...(q.period && { period: q.period as string }),
  };

  // 1. Meili path
  const meiliStart = Date.now();
  let meiliResult: any;
  let meiliError: string | undefined;
  try {
    meiliResult = await getImagesFromSearchPreFilter(input);
  } catch (err: any) {
    meiliError = err.message || String(err);
  }
  const meiliElapsed = Date.now() - meiliStart;

  // 2. BitDex path — native filter builder
  const bitdexStart = Date.now();
  let bitdexResult: any = null;
  let bitdexError: string | undefined;
  try {
    bitdexResult = await getImagesFromBitdexPreFilter(input);
  } catch (err: any) {
    bitdexError = err.message || String(err);
  }
  const bitdexElapsed = Date.now() - bitdexStart;

  // 3. Compare
  const meiliIds: number[] = meiliResult?.data?.map((d: any) => d.id) ?? [];
  const bitdexIds: number[] = bitdexResult?.ids ?? [];

  const meiliSet = new Set(meiliIds);
  const bitdexSet = new Set(bitdexIds);
  const intersection = meiliIds.filter((id) => bitdexSet.has(id));
  const unionSize = new Set([...meiliIds, ...bitdexIds]).size;
  const jaccard = unionSize > 0 ? intersection.length / unionSize : 1;

  const commonMeili = meiliIds.filter((id) => bitdexSet.has(id));
  const commonBitdex = bitdexIds.filter((id) => meiliSet.has(id));
  let orderMatch = 0;
  const minLen = Math.min(commonMeili.length, commonBitdex.length);
  for (let i = 0; i < minLen; i++) {
    if (commonMeili[i] === commonBitdex[i]) orderMatch++;
  }

  const nextCursor = meiliResult?.nextCursor != null
    ? `${offset + limit}|${meiliResult.nextCursor}`
    : null;

  return res.status(200).json({
    query: {
      sort: q.sort ?? 'Newest',
      limit,
      offset,
      entry: entry ?? null,
      cursor: q.cursor ?? null,
      nextCursor,
      browsingLevel,
    },
    meili: {
      ids: meiliIds,
      count: meiliIds.length,
      elapsed_ms: meiliElapsed,
      error: meiliError ?? null,
      sample: meiliResult?.data?.slice(0, 5)?.map((d: any) => ({
        id: d.id,
        sortAtUnix: d.sortAtUnix,
        reactionCount: d.reactionCount,
        commentCount: d.commentCount,
        nsfwLevel: d.nsfwLevel,
        type: d.type,
      })) ?? [],
    },
    bitdex: {
      ids: bitdexIds,
      count: bitdexIds.length,
      total_matched: bitdexResult?.total_matched ?? null,
      elapsed_ms: bitdexElapsed,
      elapsed_us: bitdexResult?.elapsed_us ?? null,
      error: bitdexError ?? null,
    },
    comparison: {
      intersection: intersection.length,
      jaccard: Math.round(jaccard * 1000) / 1000,
      order_match: minLen > 0 ? `${orderMatch}/${minLen}` : 'n/a',
      only_in_meili: meiliIds.filter((id) => !bitdexSet.has(id)).slice(0, 20),
      only_in_bitdex: bitdexIds.filter((id) => !meiliSet.has(id)).slice(0, 20),
    },
  });
});
