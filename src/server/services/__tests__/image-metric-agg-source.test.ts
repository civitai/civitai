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

// client.ts's transitive import graph reads `~/env/server` at module load (which
// validates all prod env in test and throws), and pulls the flipt SDK + axiom
// logger. Stub the smallest seams so importing it is side-effect-free; the
// function under test reads NONE of these — it's plain string building.
vi.mock('~/env/server', () => ({ env: new Proxy({}, { get: () => undefined }) }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('@flipt-io/flipt-client-js', () => ({ FliptClient: class {} }));

import { buildEntityMetricPerDaySource } from '~/server/flipt/client';

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
