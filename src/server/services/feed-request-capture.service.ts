import { trace } from '@opentelemetry/api';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const FEED_REQUEST_CAPTURE_TABLE = 'feedRequests';
const CONFIG_TTL_MS = 15_000;
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
const MAX_BUFFERED_ROWS = 5_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export type FeedCaptureConfig = {
  /** 0..1; 0 disables capture. */
  sampleRate: number;
  /** Epoch ms after which capture stops regardless of sampleRate. */
  until: number;
};

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

// Session, transport and presentation fields: not part of the query shape, and `user` is
// the whole session user (see redactSearchInputForLog).
const OMITTED_INPUT_KEYS = new Set([
  'user',
  'signal',
  'headers',
  'actor',
  'include',
  'resolvedHub',
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
} & Record<string, unknown>;

export type FeedRequestOutcome = {
  source: string;
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
  source: string;
  error: number;
  elapsedMs: number;
  resultCount: number;
  resultIds: number[];
  nextCursor: string;
};

const uint = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0);
const uintArray = (a: unknown) =>
  Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n) && n >= 0) : [];
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
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!OMITTED_INPUT_KEYS.has(key) && value !== undefined && value !== null) rest[key] = value;
  }
  let inputJson = '';
  try {
    inputJson = JSON.stringify(rest);
  } catch {
    inputJson = '';
  }

  return {
    time: formatClickhouseDateTime64(at),
    traceId,
    userId: uint(input.currentUserId),
    isModerator: input.isModerator ? 1 : 0,
    sort: str(input.sort),
    period: str(input.period),
    periodMode: str(input.periodMode),
    browsingLevel: uint(input.browsingLevel),
    useCombinedNsfwLevel: input.useCombinedNsfwLevel ? 1 : 0,
    limit: uint(input.limit),
    cursor: str(input.cursor),
    tags: uintArray(input.tags),
    excludedTagIds: uintArray(input.excludedTagIds),
    excludedUserIds: uintArray(input.excludedUserIds),
    modelId: uint(input.modelId),
    modelVersionId: uint(input.modelVersionId),
    filterUserId: uint(input.userId),
    postId: uint(input.postId),
    collectionId: uint(input.collectionId),
    hubId: uint(input.hubId),
    types: stringArray(input.types),
    baseModels: stringArray(input.baseModels),
    tools: uintArray(input.tools),
    techniques: uintArray(input.techniques),
    flags: FLAG_FIELDS.filter((field) => input[field] === true),
    input: inputJson,
    source: outcome.source,
    error: outcome.error ? 1 : 0,
    elapsedMs: Math.max(0, Math.round(outcome.elapsedMs)),
    resultCount: outcome.resultIds.length,
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let lastErrorAt = 0;

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    try {
      await deps.insert(rows);
    } catch (e) {
      // Sampled telemetry: a failed batch is dropped, not retried, so a ClickHouse outage
      // cannot pile up memory on the feed path.
      if (deps.onError) deps.onError(e as Error, rows.length);
      else if (now() - lastErrorAt > ERROR_LOG_INTERVAL_MS) {
        lastErrorAt = now();
        logToAxiom(
          {
            type: 'error',
            name: 'feedRequests capture flush failed',
            details: { rows: rows.length },
            message: (e as Error).message,
          },
          'clickhouse'
        ).catch(() => undefined);
      }
    }
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
        return;
      }
      buffer.push(buildFeedRequestRow(input, outcome, at, traceId));
      if (buffer.length >= FLUSH_AT_ROWS) await flush();
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
    getConfig: createTtlMemo(
      async () =>
        parseCaptureConfig(
          await sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.FEED_REQUEST_CAPTURE)
        ),
      CONFIG_TTL_MS
    ),
    insert: async (rows) => {
      await client.insert({
        table: FEED_REQUEST_CAPTURE_TABLE,
        values: rows,
        format: 'JSONEachRow',
      });
    },
  }));
}
