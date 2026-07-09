import { describe, it, expect, vi } from 'vitest';

// Guards the fix for the 2026-06-24 incident: PR #2666 deleted civitai's
// `getEntityMetricAggSource()` provider and dropped the provider arg from every
// `new MetricService(...)`, silently falling MetricService back to the submodule
// DEFAULT_AGG_SOURCE = `entityMetricDailyAgg_new`. That table was later dropped
// from ClickHouse → UNKNOWN_TABLE → 500s on /api/v1/images + on-site image feeds.
// `imageMetricAggSource` is the restored single source of truth: it MUST resolve
// to the FINAL `entityMetricDailyAgg_v2` view with no argMax dedup, and MUST NOT
// resolve to the dropped legacy `_new` table.

// client.ts's transitive import graph reads `~/env/server` at module load (which
// validates all prod env in test and throws), and pulls the flipt SDK + axiom
// logger. Stub the smallest seams so importing it is side-effect-free; the
// provider under test reads NONE of these — it's a plain hardcoded constant.
vi.mock('~/env/server', () => ({ env: new Proxy({}, { get: () => undefined }) }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('@flipt-io/flipt-client-js', () => ({ FliptClient: class {} }));

import { imageMetricAggSource } from '~/server/flipt/client';

describe('imageMetricAggSource', () => {
  it('resolves to the FINAL entityMetricDailyAgg_v2 view with no argMax dedup', () => {
    expect(imageMetricAggSource()).toEqual({
      table: 'entityMetricDailyAgg_v2',
      needsArgMaxDedup: false,
    });
  });

  it('does NOT resolve to the dropped legacy entityMetricDailyAgg_new table (the #2666 regression)', () => {
    const source = imageMetricAggSource();
    expect(source.table).not.toBe('entityMetricDailyAgg_new');
    // v2 is already FINAL — dedup must be off (argMax on the legacy table is the
    // marker of the old ReplacingMergeTree read path).
    expect(source.needsArgMaxDedup).toBe(false);
  });
});
