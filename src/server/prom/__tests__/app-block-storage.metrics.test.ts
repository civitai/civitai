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
 * Zero-seeding of the four App Blocks KV storage metrics, against the REAL prom-client default
 * registry — `@civitai/telemetry/client` is not stubbed by `src/__tests__/setup.ts`, which
 * replaces only `~/server/prom/client`. Nothing here may call `client.register.clear()`: these
 * four are constructed once at package module scope, so clearing drops them irrecoverably and
 * every later assertion would be about an empty registry.
 */

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

async function latencyCount(op: string): Promise<number | undefined> {
  return (await valuesOf(LATENCY)).find(
    (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === op
  )?.value;
}

function latencyHandle() {
  return client.register.getSingleMetric(LATENCY) as unknown as {
    observe(labels: { op: string }, value: number): void;
    zero(labels: { op: string }): void;
  };
}

beforeAll(async () => {
  await seedAppBlockStorageMetrics();
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
    for (const op of APP_STORAGE_OPS) {
      const outcomes = values.filter((v) => v.labels.op === op).map((v) => v.labels.outcome);
      for (const outcome of APP_STORAGE_OUTCOMES_ALL_OPS) {
        expect(outcomes, op).toContain(outcome);
      }
    }
  });

  it('🔴 publishes 90 series per scraped pod — 22 of them (op, outcome) PAIRS', async () => {
    // Literal, because this is the figure a cardinality budget is sized against, and the pair
    // count is NOT it: the histogram contributes 5 children x (10 buckets + `+Inf` + `_sum` +
    // `_count`) = 65, against 22 + 2 + 1 = 25 counter series. Quoting 22 as the budget
    // understates the change fourfold.
    expect(REACHABLE_OPS_SERIES.length).toBe(22);

    const total =
      (await valuesOf(OPS)).length +
      (await valuesOf(QUOTA_EXCEEDED)).length +
      (await valuesOf(USER_QUOTA_UNTRACKED)).length +
      (await valuesOf(LATENCY)).length;
    expect(total).toBe(90);

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
    // `app_block_id` is omitted, not placeholdered — prom-client drops an unsupplied label, so
    // the row's `app_block_id` is the empty string. It stays 0 forever; its job is to make
    // `absent(<metric>)` mean "the instrument is gone" rather than "no app has hit a ceiling".
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
    expect(scrape).not.toContain('civitai_app_app_blocks_storage');
  });

  it('a counter child created by real traffic survives re-seeding', async () => {
    // The counters are seeded with the additive `inc(labels, 0)` rather than a reset. Safe
    // among the read-only cases: it moves a value, never the series SET those cases assert on.
    const ops = client.register.getSingleMetric(OPS) as unknown as {
      inc(labels: { op: string; outcome: string }): void;
    };
    ops.inc({ op: 'delete', outcome: 'ok' });
    ops.inc({ op: 'delete', outcome: 'ok' });

    await seedAppBlockStorageMetrics();

    const v = (await valuesOf(OPS)).find(
      (x) => x.labels.op === 'delete' && x.labels.outcome === 'ok'
    );
    expect(v?.value).toBe(2);
  });
});

/**
 * Separate `describe` because these two RECORD latency observations. Inside the block above a
 * case appended after them would fail on `publishes one zeroed latency histogram child per op`
 * with `expected 1 to be +0` — a message that reads as "the seeding is broken" and says nothing
 * about ordering. Vitest runs describes in source order, so the split keeps that block's
 * append-point clean.
 */
describe('re-seeding is non-destructive', () => {
  it('🔴 re-seeding does NOT wipe a recorded latency observation', async () => {
    // The seeder runs on the FIRST SCRAPE, not at pod start, so by the time it first executes
    // the pod may already have served storage calls. An unconditional `zero()` would delete
    // them. This is the case that fails if `zeroMissingLatencyChildren` stops checking.
    latencyHandle().observe({ op: 'get' }, 0.5);
    expect(await latencyCount('get')).toBe(1);

    await seedAppBlockStorageMetrics();

    expect(await latencyCount('get')).toBe(1);
  });

  it('the destructive case is REACHABLE — an unconditional zero() really would delete it', async () => {
    // Proves the case above is not vacuous: the primitive it declines to call does destroy the
    // child. Without this, replacing the existence check with a bare `zero()` could leave the
    // previous case green because nothing was ever at risk.
    latencyHandle().observe({ op: 'list' }, 0.25);
    expect(await latencyCount('list')).toBe(1);

    latencyHandle().zero({ op: 'list' });

    expect(await latencyCount('list')).toBe(0);
  });
});

/**
 * The seeded label domain against the code that emits it.
 *
 * The `outcome` direction that matters — a NEW outcome emitted but not seeded — is now a
 * compile error: every emit goes through `countStorageOutcome(op, outcome)`, whose parameter is
 * `AppStorageOutcome`. These cases cover what `tsc` cannot: the opposite direction (a seeded
 * outcome nothing emits, i.e. a permanent dead zero), per-op reachability, and the scope
 * assumption both of those rest on.
 */
describe('the seeded domain matches the service', () => {
  const SRC = path.resolve(__dirname, '../../..');
  const SERVICE = path.join(SRC, 'server/services/apps/app-storage.service.ts');
  const service = () => fs.readFileSync(SERVICE, 'utf8');

  /**
   * Anchored on the emit call, NOT on the word `outcome:` anywhere in the file. That looser
   * regex matched 30 sites against 27 real ones — picking up a comment and two Axiom log
   * payloads, which passed only because both logs happened to carry `'ok'`. Renaming a log's
   * outcome word would have false-failed this, and the obvious fix (seed the new word) would
   * have manufactured the dead zero these cases exist to forbid.
   */
  // `[A-Za-z]+` for the op, not `[a-z]+` — `getQuota` is camelCase, and a case-narrow class
  // silently dropped its five sites from the count.
  const EMIT = /countStorageOutcome\(\s*(?:op|'[A-Za-z]+')\s*,\s*'([A-Za-z_]+)'\s*\)/g;

  it('every seeded outcome is emitted somewhere — no permanent dead zero', () => {
    const emitted = [...service().matchAll(EMIT)].map((m) => m[1]);
    // Exact, not `> 10`: a loose floor survived hoisting four sites to a shared const, which
    // left an outcome with zero emit sites while this case still vouched for it.
    expect(emitted.length).toBe(27);

    const emittedSet = new Set(emitted);
    for (const outcome of [...APP_STORAGE_OUTCOMES_ALL_OPS, ...APP_STORAGE_OUTCOMES_SET_ONLY]) {
      expect(emittedSet.has(outcome), outcome).toBe(true);
    }
  });

  it('🔴 every op reaches the shared resolver AND the fault counter — that is what makes the all-ops outcomes reachable', () => {
    // `APP_STORAGE_OUTCOMES_ALL_OPS` claims `unauthorized`/`not_found`/`error` are reachable
    // under every op. That rests entirely on each procedure routing through
    // `resolveStorageContext` and `countStorageFault` with its own op literal. A new procedure
    // that skips either puts a permanent dead zero on screen with nothing else red.
    const src = service();
    for (const op of APP_STORAGE_OPS) {
      expect(src, `resolveStorageContext(…, '${op}')`).toMatch(
        new RegExp(`resolveStorageContext\\([\\s\\S]{0,80}?'${op}'`)
      );
      expect(src, `countStorageFault('${op}', …)`).toContain(`countStorageFault('${op}'`);
    }
  });

  it('🔴 `countStorageOutcome` is still the only writer — every case above assumes that scope', () => {
    // A second `.inc` site would be free to pass an untyped outcome, which defeats the compile
    // check the whole arrangement now rests on.
    const emitters: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          if (/appStorageOpsCounter\s*\.inc/.test(fs.readFileSync(full, 'utf8'))) {
            emitters.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    expect(emitters.sort()).toEqual([
      'server/prom/app-block-storage.metrics.ts',
      'server/services/apps/app-storage.service.ts',
    ]);
  });
});
