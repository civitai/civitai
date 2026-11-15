import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import {
  CAPTURE_OFF,
  createSampledRowBuffer,
  parseCaptureConfig,
  type CaptureConfig,
} from '~/server/clickhouse/sampled-row-buffer';
import { registerCounterWithLabels } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export { MAX_BUFFERED_ROWS, parseCaptureConfig } from '~/server/clickhouse/sampled-row-buffer';

export const FEED_REQUEST_CAPTURE_TABLE = 'feedRequests';
const CONFIG_TTL_MS = 15_000;

const batchCounter = registerCounterWithLabels({
  name: 'feed_request_capture_batches_total',
  help: 'Feed request capture ClickHouse inserts by outcome',
  labelNames: ['outcome'] as const,
});
const rowCounter = registerCounterWithLabels({
  name: 'feed_request_capture_rows_total',
  help: 'Feed request capture rows sampled (buffered) or shed while an insert was in flight (dropped)',
  labelNames: ['outcome'] as const,
});

export type FeedCaptureConfig = CaptureConfig;

const FLAG_FIELDS = [
  'withMeta',
  'requiringMeta',
  'fromPlatform',
  'followed',
  'hidden',
  'notPublished',
  'scheduled',
  'publishedOnly',
  'hideAutoResources',
  'hideManualResources',
  'newCreators',
  'hideChallenges',
  'pending',
  'includeBaseModel',
  'disablePoi',
  'disableMinor',
] as const;

// Allowlist, not a denylist: a field added to the search input later is not captured
// until someone decides it should be (see redactSearchInputForLog for why).
export const CAPTURED_INPUT_KEYS = new Set<string>([
  ...FLAG_FIELDS,
  'currentUserId',
  'isModerator',
  'sort',
  'period',
  'periodMode',
  'browsingLevel',
  'useCombinedNsfwLevel',
  'domain',
  'limit',
  'cursor',
  'offset',
  'tags',
  'excludedTagIds',
  'excludedUserIds',
  'modelId',
  'modelVersionId',
  'model3dId',
  'userId',
  'userIds',
  'postId',
  'postIds',
  'collectionId',
  'collectionTagId',
  'hubId',
  'hubExcludedSources',
  'reviewId',
  'imageId',
  'ids',
  'types',
  'baseModels',
  'tools',
  'techniques',
  'generation',
  'reactions',
  'prioritizedUserIds',
  'blockedFor',
]);

/** The id sets a hub resolves to, in the shape `resolveHubSources` returns them. */
export type FeedHubSources = {
  userIds: number[];
  modelVersionIds: number[];
  collectionIds: number[];
  tagGroups: number[][];
  excluded: { userIds: number[]; modelVersionIds: number[]; tagGroups: number[][] };
};

export type CapturableSearchInput = {
  currentUserId?: number;
  isModerator?: boolean;
  sort?: string;
  period?: string;
  periodMode?: string;
  browsingLevel?: number;
  useCombinedNsfwLevel?: boolean;
  limit?: number;
  cursor?: unknown;
  jumpTo?: string;
  tags?: number[];
  excludedTagIds?: number[];
  excludedUserIds?: number[];
  modelId?: number;
  modelVersionId?: number;
  userId?: number;
  followed?: boolean;
  /** Resolved by the primary path only; `followed` without it is not servable. */
  followedUserIds?: number[];
  newCreators?: boolean;
  /** Resolved by the primary path only; `newCreators` without it is not servable. */
  newCreatorUserIds?: number[];
  postId?: number;
  postIds?: number[];
  /** Server-only: the caller takes a post's images in the requested sort, not the author's order. */
  postIdsInRequestedSort?: boolean;
  collectionId?: number;
  hubId?: number;
  /**
   * Resolved by the primary path only; `hubId` without it is not servable. `null` is a hub
   * that resolves to nothing for this viewer, which is an empty page and never the open feed.
   */
  hubSources?: FeedHubSources | null;
  types?: string[];
  baseModels?: string[];
  tools?: number[];
  techniques?: number[];
  headers?: Record<string, string>;
} & Record<string, unknown>;

export type FeedRequestSource = 'getImagesFromSearch' | 'getAllImages';

export type FeedRequestOutcome = {
  source: FeedRequestSource;
  /** Meili path only: which feed-fetch-filter variant answered ('none' = no search client). */
  filterMode?: 'pre' | 'post' | 'none' | 'feed';
  error?: boolean;
  elapsedMs: number;
  resultIds: number[];
  nextCursor?: unknown;
};

export type FeedRequestRow = {
  time: string;
  traceId: string;
  userId: number;
  isModerator: number;
  source: string;
  callSite: string;
  filterMode: string;
  sort: string;
  period: string;
  periodMode: string;
  browsingLevel: number;
  useCombinedNsfwLevel: number;
  limit: number;
  cursor: string;
  tags: number[];
  excludedTagIds: number[];
  excludedUserIds: number[];
  modelId: number;
  modelVersionId: number;
  filterUserId: number;
  postId: number;
  collectionId: number;
  hubId: number;
  types: string[];
  baseModels: string[];
  tools: number[];
  techniques: number[];
  flags: string[];
  input: string;
  error: number;
  elapsedMs: number;
  resultCount: number;
  resultIds: number[];
  nextCursor: string;
};

const uint = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0);
const uint16 = (n: unknown) => Math.min(uint(n), 65_535);
const uint32 = (n: unknown) => Math.min(uint(n), 4_294_967_295);
const uintArray = (a: unknown) =>
  Array.isArray(a)
    ? a.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 4_294_967_295)
    : [];
const stringArray = (a: unknown) => (Array.isArray(a) ? a.map(String) : []);
const str = (v: unknown) => (v == null ? '' : String(v));

export function buildFeedRequestRow(
  input: CapturableSearchInput,
  outcome: FeedRequestOutcome,
  at: number,
  traceId: string
): FeedRequestRow {
  const captured: Record<string, unknown> = {};
  for (const key of CAPTURED_INPUT_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null) captured[key] = value;
  }
  let inputJson = '';
  try {
    inputJson = JSON.stringify(captured);
  } catch {
    inputJson = '';
  }

  return {
    time: formatClickhouseDateTime64(at),
    traceId,
    userId: uint32(input.currentUserId),
    isModerator: input.isModerator ? 1 : 0,
    source: outcome.source,
    callSite: str(input.headers?.src),
    filterMode: outcome.filterMode ?? '',
    sort: str(input.sort),
    period: str(input.period),
    periodMode: str(input.periodMode),
    browsingLevel: uint16(input.browsingLevel),
    useCombinedNsfwLevel: input.useCombinedNsfwLevel ? 1 : 0,
    limit: uint16(input.limit),
    cursor: str(input.cursor),
    tags: uintArray(input.tags),
    excludedTagIds: uintArray(input.excludedTagIds),
    excludedUserIds: uintArray(input.excludedUserIds),
    modelId: uint32(input.modelId),
    modelVersionId: uint32(input.modelVersionId),
    filterUserId: uint32(input.userId),
    postId: uint32(input.postId),
    collectionId: uint32(input.collectionId),
    hubId: uint32(input.hubId),
    types: stringArray(input.types),
    baseModels: stringArray(input.baseModels),
    tools: uintArray(input.tools),
    techniques: uintArray(input.techniques),
    flags: FLAG_FIELDS.filter((field) => input[field] === true),
    input: inputJson,
    error: outcome.error ? 1 : 0,
    elapsedMs: uint32(Math.round(outcome.elapsedMs)),
    resultCount: uint16(outcome.resultIds.length),
    resultIds: uintArray(outcome.resultIds),
    nextCursor: str(outcome.nextCursor),
  };
}

export type FeedRequestCapture = {
  /** Fire-and-forget at call sites; returns the settled promise for tests. */
  record: (input: CapturableSearchInput, outcome: FeedRequestOutcome) => Promise<void>;
  flush: () => Promise<void>;
  readonly pending: number;
  readonly dropped: number;
};

type CaptureDeps = {
  getConfig: () => Promise<FeedCaptureConfig>;
  insert: (rows: FeedRequestRow[]) => Promise<void>;
  now?: () => number;
  random?: () => number;
  flushIntervalMs?: number;
  onError?: (error: Error, rows: number) => void;
};

export function createFeedRequestCapture(deps: CaptureDeps): FeedRequestCapture {
  const rows = createSampledRowBuffer<FeedRequestRow>({
    ...deps,
    table: FEED_REQUEST_CAPTURE_TABLE,
    counters: { batches: batchCounter, rows: rowCounter },
  });
  return {
    record: (input, outcome) =>
      rows.push((at, traceId) => buildFeedRequestRow(input, outcome, at, traceId)),
    flush: rows.flush,
    get pending() {
      return rows.pending;
    },
    get dropped() {
      return rows.dropped;
    },
  };
}

const disabledCapture: FeedRequestCapture = {
  record: async () => undefined,
  flush: async () => undefined,
  pending: 0,
  dropped: 0,
};

let instance: FeedRequestCapture | undefined;

export function feedRequestCapture(): FeedRequestCapture {
  if (instance) return instance;
  const client = clickhouse;
  if (!client) return (instance = disabledCapture);
  return (instance = createFeedRequestCapture({
    // A failed or slow read memoizes "off" for one TTL instead of re-reading per request.
    getConfig: createTtlMemo(async () => {
      try {
        return parseCaptureConfig(
          await withSysReadDeadline(
            sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.FEED_REQUEST_CAPTURE)
          )
        );
      } catch {
        return CAPTURE_OFF;
      }
    }, CONFIG_TTL_MS),
    insert: async (rows) => {
      await client.insert({
        table: FEED_REQUEST_CAPTURE_TABLE,
        values: rows,
        format: 'JSONEachRow',
      });
    },
  }));
}
