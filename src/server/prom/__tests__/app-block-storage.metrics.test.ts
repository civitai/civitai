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
 * Separate `describe` because these RECORD latency observations.
 *
 * 🔴 Every assertion here is RELATIVE to the count it reads first, never to a literal. The
 * split alone is not enough: with literals, a case appended to the block above that happens to
 * `observe()` turns the headline non-destructiveness guard red with `expected 1 to be 2` — a
 * message that reads as "the seeder went destructive again" for what is a fixture collision.
 * Relative assertions make these cases independent of whatever ran before them.
 */
describe('re-seeding is non-destructive', () => {
  it('🔴 re-seeding does NOT wipe a recorded latency observation', async () => {
    // The seeder runs on the FIRST SCRAPE, not at pod start, so by the time it first executes
    // the pod may already have served storage calls. An unconditional `zero()` would delete
    // them. This is the case that fails if `zeroMissingLatencyChildren` stops checking.
    const before = (await latencyCount('get')) ?? 0;
    latencyHandle().observe({ op: 'get' }, 0.5);
    expect(await latencyCount('get')).toBe(before + 1);

    await seedAppBlockStorageMetrics();

    expect(await latencyCount('get')).toBe(before + 1);
  });

  it('the destructive case is REACHABLE — an unconditional zero() really would delete it', async () => {
    // Proves the case above is not vacuous: the primitive it declines to call does destroy the
    // child. Without this, replacing the existence check with a bare `zero()` could leave the
    // previous case green because nothing was ever at risk.
    const before = (await latencyCount('list')) ?? 0;
    latencyHandle().observe({ op: 'list' }, 0.25);
    expect(await latencyCount('list')).toBe(before + 1);

    latencyHandle().zero({ op: 'list' });

    expect(await latencyCount('list')).toBe(0);
  });

  it('🔴 a failing latency read costs the series, never the scrape', async () => {
    // The try/catch is a scrape-AVAILABILITY guard: this runs inside the /api/metrics handler,
    // so a throw out of the seeder 500s the whole response — default metrics, every other
    // seeded counter, the Prisma series. Deleting the catch left the suite green, so the guard
    // had no case. This also pins the ordering claim: the counters go out BEFORE the leg that
    // can fail, so a failure here still leaves the alertable series published.
    const handle = client.register.getSingleMetric(LATENCY) as unknown as {
      get: () => Promise<unknown>;
    };
    const original = handle.get;
    handle.get = () => Promise.reject(new Error('registry read failed'));
    try {
      await expect(seedAppBlockStorageMetrics()).resolves.toBeUndefined();

      expect((await valuesOf(OPS)).length).toBe(22);
      expect((await valuesOf(QUOTA_EXCEEDED)).length).toBe(2);
      expect((await valuesOf(USER_QUOTA_UNTRACKED)).length).toBe(1);
    } finally {
      handle.get = original;
    }
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

    // Membership BEFORE the count, deliberately: an outcome that loses its last emit site
    // trips both, and if the count goes first the failure reads `expected 26 to be 27` instead
    // of naming the outcome that died.
    const emittedSet = new Set(emitted);
    for (const outcome of [...APP_STORAGE_OUTCOMES_ALL_OPS, ...APP_STORAGE_OUTCOMES_SET_ONLY]) {
      expect(emittedSet.has(outcome), outcome).toBe(true);
    }

    // Exact, not `> 10`: a loose floor survived hoisting four sites to a shared const, which
    // left an outcome with zero emit sites while this case still vouched for it. Every blind
    // spot in the regex (variable op, variable outcome, const indirection) DROPS the count, so
    // exactness false-fails in the safe direction.
    expect(emitted.length).toBe(27);
  });

  it('🔴 every op reaches the shared resolver AND the fault counter — that is what makes the all-ops outcomes reachable', () => {
    // `APP_STORAGE_OUTCOMES_ALL_OPS` claims `unauthorized`/`not_found`/`error` are reachable
    // under every op. That rests entirely on each procedure routing through
    // `resolveStorageContext` and `countStorageFault` with its own op literal. A new procedure
    // that skips either puts a permanent dead zero on screen with nothing else red.
    //
    // 🔴 Anchored on ARGUMENT POSITION, never a character window. A `[\s\S]{0,80}?'<op>'`
    // window reaches PAST the call into the next statement, which in three of the five
    // procedures is `countStorageOutcome('<op>', …)` — so the literal satisfying it was the
    // adjacent emit site, not the resolver argument. Measured: with the window, passing
    // `'get'` to `listAppStorageKeys`'s resolver left the whole suite green, which is exactly
    // the mislabel this case claims to catch (every `list` refusal counted as `op="get"`).
    const src = service();
    for (const op of APP_STORAGE_OPS) {
      expect(src, `resolveStorageContext(<token>, '${op}')`).toMatch(
        new RegExp(`resolveStorageContext\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*'${op}'\\s*\\)`)
      );
      expect(src, `countStorageFault('${op}', …)`).toContain(`countStorageFault('${op}'`);
      // The histogram's `op` axis carries 65 of the 90 seeded series and has no other guard:
      // an op whose timer is never started is a dead zero exactly like an unemitted outcome.
      expect(src, `startTimer({ op: '${op}' })`).toContain(
        `appStorageLatencyHistogram.startTimer({ op: '${op}' })`
      );
    }
  });

  it('🔴 only three files name the ops counter at all — every case above assumes that scope', () => {
    // Ledgers files that REFERENCE the handle, not ones that spell `.inc`. A spelled guard is
    // walkable: `const c = appStorageOpsCounter; c.inc(…)`, `.labels(op, outcome).inc()` and
    // `inc.call(appStorageOpsCounter, …)` are all first-class prom-client usage that a
    // `/appStorageOpsCounter\s*\.inc/` pattern misses — measured, all three evaded it with an
    // untyped `outcome`. A writer cannot avoid naming the symbol to import it, so this is
    // structural. Fails on growth AND shrink.
    //
    // `block-token-access.service.ts` names it in a comment only; that is still the right
    // membership test, because the claim is "nothing else can reach this counter". `__tests__`
    // is excluded — a suite that stubs the handle is not a production writer, which is why
    // this set is three files and not the four a test-inclusive walk reports.
    const referencing: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          if (fs.readFileSync(full, 'utf8').includes('appStorageOpsCounter')) {
            referencing.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    expect(referencing.sort()).toEqual([
      'server/prom/app-block-storage.metrics.ts',
      'server/services/apps/app-storage.service.ts',
      'server/services/blocks/block-token-access.service.ts',
    ]);
  });
});
