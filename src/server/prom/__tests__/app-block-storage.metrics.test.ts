import fs from 'fs';
import path from 'path';
import client from 'prom-client';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  APP_STORAGE_CEILINGS,
  APP_STORAGE_OPS,
  APP_STORAGE_OUTCOMES_ALL_OPS,
  APP_STORAGE_OUTCOMES_SET_ONLY,
  REACHABLE_OPS_SERIES,
  seedAppBlockStorageMetrics,
} from '../app-block-storage.metrics';

/**
 * ZERO-SEEDING of the four App Blocks KV storage metrics, read against the REAL
 * prom-client default registry.
 *
 * `@civitai/telemetry/client` is NOT stubbed by `src/__tests__/setup.ts` (which
 * replaces `~/server/prom/client` wholesale), and the module under test imports
 * the metric handles from the package directly — so this file sees the actual
 * registered metrics, exact names included. Same arrangement as
 * `external-moderation.metrics.test.ts`.
 *
 * 🔴 The registry is deliberately NOT cleared between cases. These four metrics
 * are constructed ONCE, at package module scope; `client.register.clear()` would
 * drop them with nothing able to re-create them, and every assertion after it
 * would be about an empty registry rather than about the code.
 */

// Literal, matching the operator-facing ledger in
// packages/civitai-telemetry/src/__tests__/app-block-storage-metric-names.test.ts.
const OPS = 'civitai_app_block_storage_ops_total';
const QUOTA_EXCEEDED = 'civitai_app_block_storage_quota_exceeded_total';
const USER_QUOTA_UNTRACKED = 'civitai_app_block_storage_user_quota_untracked_total';
const LATENCY = 'civitai_app_block_storage_latency_seconds';

type Values = Array<{ labels: Record<string, string>; value: number; metricName?: string }>;

async function valuesOf(name: string): Promise<Values> {
  const metric = client.register.getSingleMetric(name) as
    | { get(): Promise<{ values: Values }> | { values: Values } }
    | undefined;
  if (!metric) return [];
  const { values } = await metric.get();
  return values;
}

beforeAll(() => {
  // `seedAppBlockStorageMetrics` is once-only and its latch lives on globalThis
  // (see the module for why). Clear it so this file drives the real first call
  // rather than silently asserting against a no-op.
  globalThis.__civitaiAppBlockStorageMetricsSeeded = undefined;
  seedAppBlockStorageMetrics();
});

describe('seedAppBlockStorageMetrics', () => {
  it('publishes all 22 reachable (op, outcome) series of the ops counter at 0', async () => {
    const values = await valuesOf(OPS);
    expect(values.length).toBe(22);
    for (const v of values) expect(v.value).toBe(0);

    const seeded = new Set(values.map((v) => `${v.labels.op}/${v.labels.outcome}`));
    for (const { op, outcome } of REACHABLE_OPS_SERIES) {
      expect(seeded.has(`${op}/${outcome}`), `${op}/${outcome}`).toBe(true);
    }
  });

  it('🔴 seeds the set-only outcomes on `set` ONLY — a zero no code can move reads as "never happens"', async () => {
    const values = await valuesOf(OPS);
    for (const outcome of APP_STORAGE_OUTCOMES_SET_ONLY) {
      const ops = values.filter((v) => v.labels.outcome === outcome).map((v) => v.labels.op);
      expect(ops).toEqual(['set']);
    }
    // …and every op carries the four common outcomes.
    for (const op of APP_STORAGE_OPS) {
      const outcomes = values
        .filter((v) => v.labels.op === op)
        .map((v) => v.labels.outcome)
        .sort();
      for (const outcome of APP_STORAGE_OUTCOMES_ALL_OPS) {
        expect(outcomes, op).toContain(outcome);
      }
    }
  });

  it('the reachable set is EXACTLY 22 series — that is the cardinality budget', () => {
    // Literal, not `5 * 4 + 2`: this is the number the budget is sized against,
    // so a widened label domain has to come through here.
    expect(REACHABLE_OPS_SERIES.length).toBe(22);
    expect([...APP_STORAGE_OPS]).toEqual(['get', 'set', 'delete', 'list', 'getQuota']);
    expect([...APP_STORAGE_OUTCOMES_ALL_OPS]).toEqual(['ok', 'unauthorized', 'not_found', 'error']);
    expect([...APP_STORAGE_OUTCOMES_SET_ONLY]).toEqual(['payload_too_large', 'quota_exceeded']);
    expect([...APP_STORAGE_CEILINGS]).toEqual(['app', 'user']);
  });

  it('publishes one zeroed latency histogram child per op', async () => {
    const counts = (await valuesOf(LATENCY)).filter((v) => (v.metricName ?? '').endsWith('_count'));
    expect(counts.map((v) => v.labels.op).sort()).toEqual([...APP_STORAGE_OPS].sort());
    for (const v of counts) expect(v.value).toBe(0);
  });

  it('🔴 gives each app_block_id-labelled counter a presence beacon, since its label domain is unbounded', async () => {
    // There is no finite set of app ids to seed, so these get a row with
    // `app_block_id` OMITTED (prom-client accepts a partial label set and drops
    // the unsupplied label from the output — i.e. the empty string in
    // Prometheus). It stays 0 forever by construction; its only job is to make
    // `absent(<metric>)` mean "the instrument is gone" instead of "no app has
    // hit a ceiling yet".
    const quota = await valuesOf(QUOTA_EXCEEDED);
    expect(quota.length).toBe(2);
    for (const v of quota) {
      expect(v.value).toBe(0);
      expect(v.labels.app_block_id).toBeUndefined();
    }
    expect(quota.map((v) => v.labels.ceiling).sort()).toEqual(['app', 'user']);

    const untracked = await valuesOf(USER_QUOTA_UNTRACKED);
    expect(untracked.length).toBe(1);
    expect(untracked[0].value).toBe(0);
    expect(untracked[0].labels.app_block_id).toBeUndefined();
  });

  it('appears in the scrape output under the exact names an operator queries', async () => {
    const scrape = await client.register.metrics();
    expect(scrape).toContain(`${OPS}{op="set",outcome="quota_exceeded"} 0`);
    expect(scrape).toContain(`${QUOTA_EXCEEDED}{ceiling="app"} 0`);
    expect(scrape).toContain(`${USER_QUOTA_UNTRACKED} 0`);
    expect(scrape).toContain(`${LATENCY}_count{op="getQuota"} 0`);

    // The stuttering pre-fix spellings must not appear anywhere in the scrape.
    expect(scrape).not.toContain('civitai_app_app_blocks_storage');
  });

  // ─── ORDER-DEPENDENT: mutates the metrics the cases above read. Keep last. ───

  it('🔴 a second call does NOT wipe recorded data — Histogram.zero() is destructive', async () => {
    // Measured against prom-client 14.2.0: zero({op}) REPLACES that child's
    // bucket values, so an unguarded "idempotent, safe to call per request"
    // seeder deletes every latency observation on each call. The globalThis
    // latch is what prevents it; this is the case that fails if the latch goes.
    const latency = client.register.getSingleMetric(LATENCY) as unknown as {
      observe(labels: { op: string }, value: number): void;
    };
    latency.observe({ op: 'get' }, 0.5);

    const before = (await valuesOf(LATENCY)).find(
      (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === 'get'
    );
    expect(before?.value).toBe(1);

    seedAppBlockStorageMetrics();

    const after = (await valuesOf(LATENCY)).find(
      (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === 'get'
    );
    expect(after?.value).toBe(1);
  });

  it('the destructive case is REACHABLE — zero() really does delete an observation', async () => {
    // Proves the guard above is not vacuous. Calls the unguarded primitive
    // directly: without the latch, the previous case would see 0, not 1.
    const latency = client.register.getSingleMetric(LATENCY) as unknown as {
      observe(labels: { op: string }, value: number): void;
      zero(labels: { op: string }): void;
    };
    latency.observe({ op: 'list' }, 0.25);
    const before = (await valuesOf(LATENCY)).find(
      (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === 'list'
    );
    expect(before?.value).toBe(1);

    latency.zero({ op: 'list' });
    const after = (await valuesOf(LATENCY)).find(
      (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === 'list'
    );
    expect(after?.value).toBe(0);
  });
});

/**
 * The `op` dimension is type-pinned — `app-storage.service.ts` derives its
 * `StorageOp` from `APP_STORAGE_OPS`, so adding an op cannot escape the seeding.
 * The `outcome` dimension has no such pin: an outcome is a bare string literal
 * at each `.inc()` site. A new one added there but not here would be absent
 * until its first real occurrence, which is precisely the ambiguity the seeding
 * exists to end — and it would be silent. This ledger is the only guard on it.
 */
describe('seeded outcomes match the service emit sites', () => {
  const SERVICE = path.resolve(__dirname, '../../services/apps/app-storage.service.ts');

  it('every `outcome:` literal in app-storage.service.ts is a seeded outcome', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const emitted = [...src.matchAll(/outcome:\s*'([a-z_]+)'/g)].map((m) => m[1]);

    // Positive control: a zero match set would make the assertion below vacuous,
    // and the regex is the thing most likely to break (a reformat, a rename).
    expect(emitted.length).toBeGreaterThan(10);

    const seeded = new Set<string>([
      ...APP_STORAGE_OUTCOMES_ALL_OPS,
      ...APP_STORAGE_OUTCOMES_SET_ONLY,
    ]);
    expect([...new Set(emitted)].filter((o) => !seeded.has(o))).toEqual([]);
  });

  it('every seeded outcome is actually emitted somewhere — no permanent dead zero', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const emitted = new Set([...src.matchAll(/outcome:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    for (const outcome of [...APP_STORAGE_OUTCOMES_ALL_OPS, ...APP_STORAGE_OUTCOMES_SET_ONLY]) {
      expect(emitted.has(outcome), outcome).toBe(true);
    }
  });
});
