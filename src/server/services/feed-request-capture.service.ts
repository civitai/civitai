import { trace } from '@opentelemetry/api';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const FEED_REQUEST_CAPTURE_TABLE = 'feedRequests';
const CONFIG_TTL_MS = 15_000;
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
/** Rows held while an insert is in flight; beyond this they are shed, never queued. */
export const MAX_BUFFERED_ROWS = 2_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

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

export type FeedCaptureConfig = {
  /** 0..1; 0 disables capture. */
  sampleRate: number;
  /** Epoch ms after which capture stops regardless of sampleRate. */
  until: number;
};

const CAPTURE_OFF: FeedCaptureConfig = { sampleRate: 0, until: 0 };

export function parseCaptureConfig(
  raw: Record<string, string> | null | undefined
): FeedCaptureConfig {
  const rate = Number(raw?.sampleRate ?? 0);
  const untilRaw = raw?.until?.trim();
  let until = Number.POSITIVE_INFINITY;
  if (untilRaw) until = /^\d+$/.test(untilRaw) ? Number(untilRaw) : Date.parse(untilRaw);
  return {
    sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0,
    // An `until` that does not parse disables capture rather than running unbounded.
    until: Number.isNaN(until) ? 0 : until,
  };
}

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
  tags?: number[];
  excludedTagIds?: number[];
  excludedUserIds?: number[];
  modelId?: number;
  modelVersionId?: number;
  userId?: number;
  postId?: number;
  collectionId?: number;
  hubId?: number;
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
  filterMode?: 'pre' | 'post' | 'none';
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

export function formatClickhouseDateTime64(epochMs: number) {
  return new Date(epochMs).toISOString().slice(0, 23).replace('T', ' ');
}

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
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  let buffer: FeedRequestRow[] = [];
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let lastErrorAt = 0;

  function reportFailure(e: Error, rows: number) {
    batchCounter.inc({ outcome: 'failed' });
    if (deps.onError) return deps.onError(e, rows);
    if (now() - lastErrorAt <= ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now();
    logToAxiom(
      {
        type: 'error',
        name: 'feedRequests capture flush failed',
        details: { rows },
        message: e.message,
      },
      'clickhouse'
    ).catch(() => undefined);
  }

  // One insert at a time: a slow ClickHouse holds one batch plus the bounded buffer,
  // not an unbounded set of in-flight requests.
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inflight || buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    inflight = deps
      .insert(rows)
      .then(
        () => batchCounter.inc({ outcome: 'ok' }),
        (e) => reportFailure(e as Error, rows.length)
      )
      .finally(() => {
        inflight = null;
        if (buffer.length) scheduleFlush();
      });
    await inflight;
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function record(input: CapturableSearchInput, outcome: FeedRequestOutcome) {
    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
    const at = now();
    try {
      const config = await deps.getConfig();
      if (config.sampleRate <= 0 || at > config.until) return;
      if (random() >= config.sampleRate) return;
      if (buffer.length >= MAX_BUFFERED_ROWS) {
        dropped++;
        rowCounter.inc({ outcome: 'dropped' });
        return;
      }
      buffer.push(buildFeedRequestRow(input, outcome, at, traceId));
      rowCounter.inc({ outcome: 'buffered' });
      if (buffer.length >= FLUSH_AT_ROWS) void flush();
      else scheduleFlush();
    } catch {
      // Capture must never surface on the feed path.
    }
  }

  return {
    record,
    flush,
    get pending() {
      return buffer.length;
    },
    get dropped() {
      return dropped;
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
