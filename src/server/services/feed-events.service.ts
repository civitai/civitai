import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import {
  CAPTURE_OFF,
  createSampledRowBuffer,
  type CaptureConfig,
  type SampledRowBufferDeps,
} from '~/server/clickhouse/sampled-row-buffer';
import { ensureFliptInitialized, getFliptVariantDetailSync } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import type { TrackFeedInput } from '~/server/schema/track.schema';
import { pageRouteLabel } from '~/server/utils/page-routes';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import {
  FEED_EVENT_FILTER_KEYS,
  FEED_EVENT_FILTER_VALUE_MAX,
  FEED_EVENT_FILTER_VALUE_PATTERN,
  FEED_EVENT_SORT_PATTERN,
} from '~/shared/constants/feed-events.constants';

export const FEED_EVENTS_TABLE = 'feedEvents';
// The share of browser sessions recorded. A Flipt variant whose key is the rate ("0.1"), so the
// dial moves without a deploy; no match, an unknown key or Flipt down all read as 0 (off).
export const FEED_EVENTS_SAMPLE_RATE_FLAG = 'feed-events-sample-rate';
const CONFIG_TTL_MS = 15_000;

const batchCounter = registerCounterWithLabels({
  name: 'feed_events_batches_total',
  help: 'Feed event ClickHouse inserts by outcome',
  labelNames: ['outcome'] as const,
});
const rowCounter = registerCounterWithLabels({
  name: 'feed_events_rows_total',
  help: 'Feed event rows sampled (buffered) or shed while an insert was in flight (dropped)',
  labelNames: ['outcome'] as const,
});

export type FeedEventViewer = { userId: number; memberType: string };

export type FeedEventRow = {
  time: string;
  event: TrackFeedInput['event'];
  userId: number;
  memberType: string;
  sessionKey: string;
  feed: TrackFeedInput['feed'];
  page: string;
  sort: string;
  pageIndex: number;
  filters: Record<string, string>;
  entityType: string;
  entityId: number;
  position: number;
  seenIds: number[];
};

export function parseSampleRate(variantKey: string | undefined): number {
  const rate = Number(variantKey);
  return Number.isFinite(rate) && rate > 0 ? Math.min(rate, 1) : 0;
}

/** Keeps only the keys this feed may carry, with values shaped like a filter control's. */
export function allowedFilters(
  feed: TrackFeedInput['feed'],
  filters: Record<string, string>
): Record<string, string> {
  const allowed = FEED_EVENT_FILTER_KEYS[feed];
  const kept: Record<string, string> = {};
  for (const key of allowed) {
    const value = filters[key];
    if (
      typeof value === 'string' &&
      value.length <= FEED_EVENT_FILTER_VALUE_MAX &&
      FEED_EVENT_FILTER_VALUE_PATTERN.test(value)
    )
      kept[key] = value;
  }
  return kept;
}

export function buildFeedEventRow(
  input: TrackFeedInput,
  viewer: FeedEventViewer,
  at: number
): FeedEventRow {
  return {
    time: formatClickhouseDateTime64(at),
    event: input.event,
    userId: viewer.userId,
    memberType: viewer.memberType,
    sessionKey: input.sessionKey,
    feed: input.feed,
    page: pageRouteLabel(input.page),
    sort: input.sort === '' || FEED_EVENT_SORT_PATTERN.test(input.sort) ? input.sort : 'other',
    pageIndex: input.pageIndex,
    filters: allowedFilters(input.feed, input.filters),
    entityType: input.event === 'click' ? input.entityType ?? '' : '',
    entityId: input.event === 'click' ? input.entityId ?? 0 : 0,
    position: input.event === 'click' ? input.position ?? 0 : 0,
    seenIds: input.event === 'seen' ? input.seenIds ?? [] : [],
  };
}

export type FeedEventsRecorder = {
  record: (input: TrackFeedInput, viewer: FeedEventViewer) => Promise<void>;
  flush: () => Promise<void>;
};

export function createFeedEventsRecorder(
  deps: Omit<SampledRowBufferDeps<FeedEventRow>, 'table' | 'counters'>
): FeedEventsRecorder {
  const rows = createSampledRowBuffer<FeedEventRow>({
    ...deps,
    table: FEED_EVENTS_TABLE,
    counters: { batches: batchCounter, rows: rowCounter },
  });
  return {
    // Sampled per browser session, so a session's loads, seen rows and clicks are kept together.
    record: (input, viewer) =>
      rows.push((at) => buildFeedEventRow(input, viewer, at), { sampleKey: input.sessionKey }),
    flush: rows.flush,
  };
}

const disabledRecorder: FeedEventsRecorder = {
  record: async () => undefined,
  flush: async () => undefined,
};

let instance: FeedEventsRecorder | undefined;

export function feedEventsRecorder(): FeedEventsRecorder {
  if (instance) return instance;
  const client = clickhouse;
  if (!client) return (instance = disabledRecorder);
  return (instance = createFeedEventsRecorder({
    getConfig: createTtlMemo(async (): Promise<CaptureConfig> => {
      try {
        await ensureFliptInitialized();
        const detail = getFliptVariantDetailSync(FEED_EVENTS_SAMPLE_RATE_FLAG);
        const sampleRate = detail?.match ? parseSampleRate(detail.variantKey ?? undefined) : 0;
        return { sampleRate, until: Number.POSITIVE_INFINITY };
      } catch {
        return CAPTURE_OFF;
      }
    }, CONFIG_TTL_MS),
    insert: async (rows) => {
      await client.insert({ table: FEED_EVENTS_TABLE, values: rows, format: 'JSONEachRow' });
    },
  }));
}
