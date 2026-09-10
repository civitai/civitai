export const FEED_SHADOW_TABLE = 'feedShadow';

/** One sampled image-feed search, as answered by Meilisearch and by the feed service. */
export type FeedShadowRow = {
  time: string;
  traceId: string;
  userId: number;
  sort: string;
  period: string;
  browsingLevel: number;
  useCombinedNsfwLevel: number;
  cursor: string;
  input: string;
  feedQuery: string;
  skipReason: string;
  feedStatus: number;
  feedMs: number;
  feedRoute: string;
  feedEstimate: number;
  feedCandidates: number;
  feedCount: number;
  feedIds: number[];
  meiliMs: number;
  meiliCount: number;
  meiliIds: number[];
  overlap: number;
  overlapTop10: number;
  firstMismatch: number;
  error: number;
};
