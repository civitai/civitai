import { describe, it, expect, vi } from 'vitest';

// Guards the 2026-06-24 incident: the legacy ReplacingMergeTree
// `entityMetricDailyAgg_new` was dropped from ClickHouse, and a reader still
// pointed at it threw UNKNOWN_TABLE (~100k/hr) → 500s on /api/v1/images and
// on-site image feeds.
//
// There are two entity-metric readers and they MUST agree on the table:
//   - `MetricService` (watcher-fed `metrics:*` cache populate) — now hardcodes
//     `entityMetricDailyAgg_v2` in event-engine-common, so it can no longer be
//     pointed anywhere else from this repo.
//   - the direct CH subquery sites — via `buildEntityMetricPerDaySource`, which
//     is what this test pins.
//
// (This previously asserted on `imageMetricAggSource`, a civitai-side provider
// passed into MetricService. That provider is gone: the submodule hardcodes v2,
// so the provider arg was dropped from every `new MetricService(...)`.)

// client.ts builds a flipt client at module load and pulls the flipt SDK + axiom
// logger; the function under test reads none of it — it is plain string building.
// The canonical env registration covers the env side. `createFliptClient` resolves
// its connection lazily inside getInstance(), so a real FLIPT_URL default here
// still opens no socket.
vi.mock('@flipt-io/flipt-client-js', () => ({ FliptClient: class {} }));

import { buildEntityMetricPerDaySource } from '~/server/flipt/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

describe('buildEntityMetricPerDaySource', () => {
  const sql = buildEntityMetricPerDaySource(`WHERE entityType = 'Image'`);

  it('reads the FINAL entityMetricDailyAgg_v2 view', () => {
    expect(sql).toContain('entityMetricDailyAgg_v2');
  });

  it('does NOT read the dropped legacy entityMetricDailyAgg_new table', () => {
    expect(sql).not.toContain('entityMetricDailyAgg_new');
  });

  it('selects total directly — v2 is already FINAL, so no argMax dedup', () => {
    expect(sql).not.toContain('argMax');
    expect(sql).toContain('SELECT entityId, metricType, day, total');
  });

  it('carries the caller WHERE clause through', () => {
    expect(sql).toContain(`WHERE entityType = 'Image'`);
  });
});
