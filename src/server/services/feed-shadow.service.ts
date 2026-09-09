import { trace } from '@opentelemetry/api';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import {
  buildFeedRequestRow,
  type CapturableSearchInput,
  type FeedRequestOutcome,
} from '~/server/services/feed-request-capture.service';

export const FEED_SHADOW_TABLE = 'feedShadow';
export const MAX_OFFSET = 20_000;
const CONFIG_TTL_MS = 15_000;
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
export const MAX_BUFFERED_ROWS = 2_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

const requestCounter = registerCounterWithLabels({
  name: 'feed_shadow_requests_total',
  help: 'Image-feed searches mirrored to the candidate feed, by outcome',
  labelNames: ['outcome'] as const,
});
const batchCounter = registerCounterWithLabels({
  name: 'feed_shadow_batches_total',
  help: 'Feed shadow ClickHouse inserts by outcome',
  labelNames: ['outcome'] as const,
});

export type FeedShadowConfig = {
  sampleRate: number;
  until: number;
  timeoutMs: number;
  maxInflight: number;
};

const SHADOW_OFF: FeedShadowConfig = { sampleRate: 0, until: 0, timeoutMs: 2500, maxInflight: 32 };

export function parseShadowConfig(
  raw: Record<string, string> | null | undefined
): FeedShadowConfig {
  const rate = Number(raw?.sampleRate ?? 0);
  const untilRaw = raw?.until?.trim();
  let until = Number.POSITIVE_INFINITY;
  if (untilRaw) until = /^\d+$/.test(untilRaw) ? Number(untilRaw) : Date.parse(untilRaw);
  const timeoutMs = Number(raw?.timeoutMs ?? SHADOW_OFF.timeoutMs);
  const maxInflight = Number(raw?.maxInflight ?? SHADOW_OFF.maxInflight);
  return {
    sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0,
    until: Number.isNaN(until) ? 0 : until,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, 10_000)
        : SHADOW_OFF.timeoutMs,
    maxInflight:
      Number.isInteger(maxInflight) && maxInflight > 0
        ? Math.min(maxInflight, 256)
        : SHADOW_OFF.maxInflight,
  };
}

const SORTS: Record<string, string> = {
  'Most Reactions': 'reactions',
  'Most Collected': 'collected',
  'Most Comments': 'comments',
  Newest: 'newest',
  Oldest: 'oldest',
};
const PERIOD_DAYS: Record<string, number | undefined> = {
  Day: 1,
  Week: 7,
  Month: 30,
  Year: 365,
  AllTime: undefined,
};
const LEVELS = [1, 2, 4, 8, 16, 32];
// Filters the candidate has no dimension for; the app resolves the server-side lists
// (followed, hidden, newCreators) inside the search functions, out of this hook's reach.
const UNSUPPORTED_KEYS = [
  'postId',
  'postIds',
  'collectionId',
  'collectionTagId',
  'hubId',
  'reviewId',
  'prioritizedUserIds',
  'imageId',
  'generation',
  'reactions',
  'blockedFor',
] as const;
const UNSUPPORTED_FLAGS = [
  'followed',
  'newCreators',
  'hidden',
  'withMeta',
  'requiringMeta',
  'fromPlatform',
  'hideAutoResources',
  'hideManualResources',
  'hideChallenges',
  'pending',
  'publishedOnly',
] as const;

const present = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === 0 ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  );
const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];

export type FeedQueryMapping = { ok: true; query: string } | { ok: false; reason: string };
export type FeedQueryMode = 'shadow' | 'primary';

// A feed-served page continues with the feed's own keyset cursor. It carries no `|` on
// purpose: getAllImagesIndex splits the client cursor on `|` and reads numbers, so a
// feed cursor handed to the Meilisearch path parses as offset 0, a clean restart.
const FEED_CURSOR_RE = /^feed:(\d{1,16}):(\d{1,12})$/;
export const encodeFeedCursor = (next: string) => `feed:${next.replace('|', ':')}`;
export function parseFeedCursor(cursor: unknown): string | undefined {
  const m = typeof cursor === 'string' ? FEED_CURSOR_RE.exec(cursor) : null;
  return m ? `${m[1]}|${m[2]}` : undefined;
}

/** The candidate's query for a search input, or the first reason it cannot be expressed. */
export function mapSearchInputToFeedQuery(
  input: CapturableSearchInput,
  mode: FeedQueryMode = 'shadow'
): FeedQueryMapping {
  const skip = (reason: string): FeedQueryMapping => ({ ok: false, reason });
  for (const key of UNSUPPORTED_KEYS) if (present(input[key])) return skip(`input:${key}`);
  for (const flag of UNSUPPORTED_FLAGS) if (input[flag] === true) return skip(`flag:${flag}`);

  let offset = 0;
  let before: number | undefined;
  const cursor = input.cursor;
  const feedCursor = parseFeedCursor(cursor);
  if (feedCursor) {
    if (mode !== 'primary') return skip('cursor:feed');
  } else if (typeof cursor === 'string' && cursor) {
    const m = /^(\d{1,12})\|(\d{1,15})$/.exec(cursor);
    if (!m) return skip('cursor:unparsed');
    offset = Number(m[1]);
    before = Math.floor(Number(m[2]) / 60_000) * 60_000;
  } else if (cursor) return skip('cursor:unparsed');
  if (typeof input.offset === 'number' && input.offset > 0) offset = Math.max(offset, input.offset);
  if (offset > MAX_OFFSET) return skip(`offset>${MAX_OFFSET}`);

  const sort = SORTS[String(input.sort)];
  if (!sort) return skip(`sort:${String(input.sort || 'none')}`);
  const period = String(input.period ?? 'AllTime');
  if (!(period in PERIOD_DAYS)) return skip(`period:${period}`);
  const mask = typeof input.browsingLevel === 'number' ? input.browsingLevel : 1;
  const levels = LEVELS.filter((l) => (mask & l) !== 0);
  if (!levels.length) return skip('browsingLevel:0');

  const tags = ints(input.tags);
  const excludedTags = ints(input.excludedTagIds);
  if (tags.length > 100) return skip('tags>100');
  if (excludedTags.length > 100) return skip('excludedTags>100');
  const types = Array.isArray(input.types) ? input.types.map(String) : [];
  if (types.some((t) => !['image', 'video', 'audio'].includes(t)))
    return skip(`types:${types.join(',')}`);

  let versionIds: number[] | undefined;
  if (present(input.modelVersionId)) versionIds = [Number(input.modelVersionId)];
  else if (present(input.modelId)) return skip('modelId');
  const userId = present(input.userId) ? Number(input.userId) : undefined;
  const visibility =
    input.notPublished === true
      ? 'unpublished'
      : input.scheduled === true
      ? 'scheduled'
      : undefined;
  if (visibility && !userId) return skip(`flag:${visibility}:no-user`);

  const params = new URLSearchParams();
  params.set('levels', levels.join(','));
  if (input.useCombinedNsfwLevel) params.set('combinedLevels', '1');
  if (tags.length) params.set('tags', tags.join(','));
  if (excludedTags.length) params.set('excludedTags', excludedTags.join(','));
  const excludedUsers = ints(input.excludedUserIds);
  if (excludedUsers.length) params.set('excludedUserIds', excludedUsers.slice(0, 1000).join(','));
  if (versionIds) params.set('versionIds', versionIds.join(','));
  if (userId) params.set('userIds', String(userId));
  if (types.length) params.set('types', types.join(','));
  const baseModels = Array.isArray(input.baseModels)
    ? input.baseModels.map(String).filter(Boolean)
    : [];
  if (baseModels.length) params.set('baseModels', baseModels.join(','));
  const tools = ints(input.tools);
  if (tools.length) params.set('tools', tools.join(','));
  const techniques = ints(input.techniques);
  if (techniques.length) params.set('techniques', techniques.join(','));
  const ids = ints(input.ids);
  if (ids.length) params.set('ids', ids.slice(0, 200).join(','));
  if (present(input.model3dId)) params.set('model3dIds', String(input.model3dId));
  if (visibility) params.set('visibility', visibility);
  params.set('sort', sort);
  const days = PERIOD_DAYS[period];
  if (days) params.set('periodDays', String(days));
  const limit =
    typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 200) : 100;
  params.set('limit', String(limit));
  if (feedCursor) params.set('cursor', feedCursor);
  else if (offset) params.set('offset', String(offset));
  if (before) params.set('before', String(before));
  return { ok: true, query: params.toString() };
}

export type FeedAnswer = {
  nextCursor?: string;
  status: number;
  ms: number;
  ids: number[];
  route?: string;
  estimate?: number;
  candidates?: number;
};

export function compareIds(meili: number[], feed: number[]) {
  const feedSet = new Set(feed);
  const hits = meili.filter((id) => feedSet.has(id)).length;
  const top = meili.slice(0, 10);
  const topHits = top.filter((id) => feedSet.has(id)).length;
  let firstMismatch = -1;
  const n = Math.min(meili.length, feed.length);
  for (let i = 0; i < n; i++) {
    if (meili[i] !== feed[i]) {
      firstMismatch = i;
      break;
    }
  }
  return {
    overlap: meili.length ? hits / meili.length : feed.length ? 0 : 1,
    overlapTop10: top.length ? topHits / top.length : feed.length ? 0 : 1,
    firstMismatch,
  };
}

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

const u32 = (n: number | undefined) => Math.min(Math.max(Math.round(n ?? 0), 0), 4_294_967_295);

export function buildFeedShadowRow(
  input: CapturableSearchInput,
  outcome: FeedRequestOutcome,
  at: number,
  traceId: string,
  mapping: FeedQueryMapping,
  answer?: FeedAnswer
): FeedShadowRow {
  const base = buildFeedRequestRow(input, outcome, at, traceId);
  const cmp = answer
    ? compareIds(base.resultIds, answer.ids)
    : { overlap: 0, overlapTop10: 0, firstMismatch: -1 };
  return {
    time: base.time,
    traceId,
    userId: base.userId,
    sort: base.sort,
    period: base.period,
    browsingLevel: base.browsingLevel,
    useCombinedNsfwLevel: base.useCombinedNsfwLevel,
    cursor: base.cursor,
    input: base.input,
    feedQuery: mapping.ok ? mapping.query : '',
    skipReason: mapping.ok ? '' : mapping.reason,
    feedStatus: answer?.status ?? 0,
    feedMs: u32(answer?.ms),
    feedRoute: answer?.route ?? '',
    feedEstimate: u32(answer?.estimate),
    feedCandidates: u32(answer?.candidates),
    feedCount: Math.min(answer?.ids.length ?? 0, 65_535),
    feedIds: answer?.ids ?? [],
    meiliMs: base.elapsedMs,
    meiliCount: base.resultCount,
    meiliIds: base.resultIds,
    overlap: cmp.overlap,
    overlapTop10: cmp.overlapTop10,
    firstMismatch: cmp.firstMismatch,
    error: outcome.error || (answer !== undefined && answer.status !== 200) ? 1 : 0,
  };
}

export type FeedShadow = {
  /** Fire-and-forget at the call site; returns the settled promise for tests. */
  compare: (input: CapturableSearchInput, outcome: FeedRequestOutcome) => Promise<void>;
  flush: () => Promise<void>;
  readonly pending: number;
  readonly inflight: number;
  readonly dropped: number;
};

type ShadowDeps = {
  getConfig: () => Promise<FeedShadowConfig>;
  fetchFeed: (query: string, timeoutMs: number) => Promise<FeedAnswer>;
  insert: (rows: FeedShadowRow[]) => Promise<void>;
  now?: () => number;
  random?: () => number;
  flushIntervalMs?: number;
  onError?: (error: Error, rows: number) => void;
};

export function createFeedShadow(deps: ShadowDeps): FeedShadow {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  let buffer: FeedShadowRow[] = [];
  let inflightInsert: Promise<void> | null = null;
  let inflight = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let lastErrorAt = 0;

  function reportFailure(e: Error, rows: number) {
    batchCounter.inc({ outcome: 'failed' });
    if (deps.onError) return deps.onError(e, rows);
    if (now() - lastErrorAt <= ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now();
    logToAxiom(
      { type: 'error', name: 'feedShadow flush failed', details: { rows }, message: e.message },
      'clickhouse'
    ).catch(() => undefined);
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inflightInsert || buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    inflightInsert = deps
      .insert(rows)
      .then(
        () => batchCounter.inc({ outcome: 'ok' }),
        (e) => reportFailure(e as Error, rows.length)
      )
      .finally(() => {
        inflightInsert = null;
        if (buffer.length) scheduleFlush();
      });
    await inflightInsert;
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  function push(row: FeedShadowRow) {
    if (buffer.length >= MAX_BUFFERED_ROWS) {
      dropped++;
      requestCounter.inc({ outcome: 'dropped' });
      return;
    }
    buffer.push(row);
    if (buffer.length >= FLUSH_AT_ROWS) void flush();
    else scheduleFlush();
  }

  async function compare(input: CapturableSearchInput, outcome: FeedRequestOutcome) {
    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
    const at = now();
    try {
      const config = await deps.getConfig();
      if (config.sampleRate <= 0 || at > config.until) return;
      if (random() >= config.sampleRate) return;
      const mapping = mapSearchInputToFeedQuery(input);
      if (!mapping.ok) {
        requestCounter.inc({ outcome: 'skipped' });
        push(buildFeedShadowRow(input, outcome, at, traceId, mapping));
        return;
      }
      if (inflight >= config.maxInflight) {
        dropped++;
        requestCounter.inc({ outcome: 'dropped' });
        return;
      }
      inflight++;
      let answer: FeedAnswer;
      try {
        answer = await deps.fetchFeed(mapping.query, config.timeoutMs);
      } catch (e) {
        const timedOut =
          (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
        requestCounter.inc({ outcome: timedOut ? 'timeout' : 'error' });
        answer = { status: timedOut ? 504 : 0, ms: now() - at, ids: [] };
      } finally {
        inflight--;
      }
      requestCounter.inc({ outcome: answer.status === 200 ? 'compared' : 'error' });
      push(buildFeedShadowRow(input, outcome, at, traceId, mapping, answer));
    } catch {
      // Shadow mode must never surface on the feed path.
    }
  }

  return {
    compare,
    flush,
    get pending() {
      return buffer.length;
    },
    get inflight() {
      return inflight;
    },
    get dropped() {
      return dropped;
    },
  };
}

const disabledShadow: FeedShadow = {
  compare: async () => undefined,
  flush: async () => undefined,
  pending: 0,
  inflight: 0,
  dropped: 0,
};

export async function fetchFeedAnswer(
  baseUrl: string,
  query: string,
  timeoutMs: number,
  source: FeedQueryMode = 'shadow'
): Promise<FeedAnswer> {
  const started = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/feed?${query}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-request-source': source },
  });
  const ms = Date.now() - started;
  if (!res.ok) return { status: res.status, ms, ids: [] };
  const body = (await res.json()) as {
    items?: number[];
    nextCursor?: string;
    route?: string;
    estimate?: number;
    candidates?: number;
  };
  return {
    status: res.status,
    ms,
    ids: ints(body.items),
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : undefined,
    route: body.route,
    estimate: body.estimate,
    candidates: body.candidates,
  };
}

let instance: FeedShadow | undefined;

export function feedShadow(): FeedShadow {
  if (instance) return instance;
  const client = clickhouse;
  const baseUrl = env.FEED_SERVICE_URL;
  if (!client || !baseUrl) return (instance = disabledShadow);
  return (instance = createFeedShadow({
    getConfig: createTtlMemo(async () => {
      try {
        return parseShadowConfig(
          await withSysReadDeadline(sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.FEED_SHADOW))
        );
      } catch {
        return SHADOW_OFF;
      }
    }, CONFIG_TTL_MS),
    fetchFeed: (query, timeoutMs) => fetchFeedAnswer(baseUrl, query, timeoutMs),
    insert: async (rows) => {
      await client.insert({ table: FEED_SHADOW_TABLE, values: rows, format: 'JSONEachRow' });
    },
  }));
}
