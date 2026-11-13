import { EntityType } from '../types/metric-types';

const metric = (entityType: EntityType, id: number) => `metrics:${entityType}:${id}`;

export const cacheKeys = {
  metric,
  metricLock: (entityType: EntityType, id: number) => `metrics:lock:${entityType}:${id}`,
  // Set by the event-engine for a first-seen event of the metrics it marks (see
  // RECENT_EVENT_METRIC_TYPES in its redis-cache.ts). Hash-tagged to the metric hash's cluster slot,
  // because the scripts that write either key also touch the other.
  metricRecentEvent: (entityType: EntityType, id: number) => `{${metric(entityType, id)}}:recent`,
};

// How long a metric event's marker lives. It has to outlast the event's trip into the
// ClickHouse totals a populate reads (about 3 min healthy, about 10 min seen when degraded).
export const METRIC_RECENT_EVENT_TTL = 15 * 60;
