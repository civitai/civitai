import fs from 'fs';
import path from 'path';
import client from 'prom-client';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
    // had no case.
    //
    // 🔴 MEMBERSHIP throughout, per this describe's header — no totals and no literal series
    // set. An earlier draft asserted `toBe(22)`, which cannot fail (`beforeAll` has already
    // published those series, so a count passes whether or not THIS invocation wrote anything)
    // and which misattributed: a case appended to the first describe that incremented one pair
    // turned this red with `expected 23 to be 22`, reading as "the scrape lost series". The
    // ceiling half had the same defect one step smaller — `toEqual(['app','user'])` is an exact
    // series set, so any appended quota-refusal case (real code always supplies
    // `app_block_id`, so it creates a third child) tripped it the same way.
    const handle = client.register.getSingleMetric(LATENCY) as unknown as {
      get: () => Promise<unknown>;
    };
    const original = handle.get;
    handle.get = () => Promise.reject(new Error('registry read failed'));
    try {
      await expect(seedAppBlockStorageMetrics()).resolves.toBeUndefined();

      const pairs = new Set((await valuesOf(OPS)).map((v) => `${v.labels.op}/${v.labels.outcome}`));
      for (const { op, outcome } of REACHABLE_OPS_SERIES) {
        expect(pairs.has(`${op}/${outcome}`), `${op}/${outcome}`).toBe(true);
      }
      const ceilings = new Set((await valuesOf(QUOTA_EXCEEDED)).map((v) => v.labels.ceiling));
      for (const ceiling of APP_STORAGE_CEILINGS) {
        expect(ceilings.has(ceiling), ceiling).toBe(true);
      }
    } finally {
      handle.get = original;
    }

    // Nothing else asserted the patch came back. Neutering the `finally` leaves this file
    // green; the leak only surfaces in whichever case is appended next, attributed to it.
    expect(handle.get).toBe(original);
  });

  it('🔴 BOTH counters are written BEFORE the leg that can fail', async () => {
    // The ordering the module comment claims, pinned as ORDER rather than as end state. The
    // end state cannot see it — `beforeAll` has already published everything, so reversing the
    // legs leaves every count correct. Measured: with a state-only assertion, moving
    // `zeroMissingLatencyChildren()` to the top of the `try` stayed green, while on a real
    // pod's first scrape that reversal plus a failing read publishes nothing at all.
    //
    // 🔴 BOTH counters, because spying only the ops one pinned the half that matters LEAST.
    // The module docstring's claim is about "the series with alerting consumers", and the
    // counter with the alerting consumer is `quota_exceeded` — yet with ops alone, moving the
    // histogram leg to sit BETWEEN the two counter loops measured 17/17 green while leaving
    // `quota_exceeded` and `user_quota_untracked` unpublished on a failing first scrape. One
    // spy per counter, each required to precede the read.
    // `{ inc: () => void }` rather than a rest-param signature: the arity is irrelevant here
    // (vitest calls through, so the real arguments are forwarded untouched) and a `(...args:
    // never[])` type trips `no-unused-vars` on the parameter name.
    const incTarget = (name: string) =>
      client.register.getSingleMetric(name) as unknown as { inc: () => void };
    const opsSpy = vi.spyOn(incTarget(OPS), 'inc');
    const quotaSpy = vi.spyOn(incTarget(QUOTA_EXCEEDED), 'inc');
    const untrackedSpy = vi.spyOn(incTarget(USER_QUOTA_UNTRACKED), 'inc');
    const getSpy = vi.spyOn(
      client.register.getSingleMetric(LATENCY) as unknown as { get: () => Promise<unknown> },
      'get'
    );
    try {
      await seedAppBlockStorageMetrics();

      expect(getSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
      const read = getSpy.mock.invocationCallOrder[0];
      for (const [label, spy] of [
        ['ops', opsSpy],
        ['quota_exceeded', quotaSpy],
        ['user_quota_untracked', untrackedSpy],
      ] as const) {
        expect(spy.mock.invocationCallOrder.length, label).toBeGreaterThan(0);
        expect(spy.mock.invocationCallOrder[0], label).toBeLessThan(read);
      }
    } finally {
      for (const spy of [opsSpy, quotaSpy, untrackedSpy, getSpy]) spy.mockRestore();
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
  /**
   * Every counter whose emits are funnelled through a typed wrapper. Each must appear exactly
   * twice in each writer — the import and the one use — so an alias, a `.call`, or a second raw
   * emit has to add an occurrence.
   */
  const LEDGERED_WRITERS = [
    'appStorageOpsCounter',
    'appStorageQuotaExceededCounter',
    'appStorageUserQuotaUntrackedCounter',
  ] as const;
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
      // `[^,()]+` for argument 1, not a bare-identifier class: `input.blockToken`, `token!` and
      // `'get' as const` all reach the resolver perfectly well, and a narrow class false-fails
      // them with a message that reads as "this op is unreachable". Argument POSITION is the
      // property; the token's spelling is not. Never a character window — a `[\s\S]{0,80}?`
      // window runs past the closing paren into the adjacent `countStorageOutcome('<op>', …)`,
      // which left three of the five ops matching their own emit site instead.
      expect(src, `resolveStorageContext(<token>, '${op}')`).toMatch(
        new RegExp(`resolveStorageContext\\(\\s*[^,()]+\\s*,\\s*'${op}'\\s*\\)`)
      );
      expect(src, `countStorageFault('${op}', …)`).toContain(`countStorageFault('${op}'`);
    }

    // 🔴 The histogram's `op` axis carries 65 of the 90 seeded series. Paired PER PROCEDURE,
    // not per file: a whole-file `toContain` cannot see a SWAP, and swapping the `op` labels on
    // two `startTimer` calls leaves both literals present — measured, it survived. A swap is
    // the same mislabel the resolver anchoring above exists to catch, on the bigger axis.
    const procedures = src.split('\nexport async function ').slice(1);
    // 🔴 Pin the PARTITION, not just its contents. Nothing else asserts the split produced five
    // chunks, and `export const <name> = async` is this repo's other export idiom — 556 sites
    // across 72 service files, two of them in this very directory. Convert one procedure to it
    // and two procedures merge into one chunk, at which point the pairing below degrades to
    // exactly the whole-file `toContain` it replaced: measured, an arrow conversion PLUS a
    // get/set label swap went 17/17 green, with no warning of any kind.
    expect(procedures.length, 'the file partitions into the 5 storage procedures').toBe(
      APP_STORAGE_OPS.length
    );
    for (const op of APP_STORAGE_OPS) {
      const owning = procedures.filter((body) =>
        new RegExp(`resolveStorageContext\\(\\s*[^,()]+\\s*,\\s*'${op}'\\s*\\)`).test(body)
      );
      expect(owning.length, `exactly one procedure resolves '${op}'`).toBe(1);
      expect(owning[0], `the '${op}' procedure times itself as '${op}'`).toContain(
        `appStorageLatencyHistogram.startTimer({ op: '${op}' })`
      );
    }
  });

  it('🔴 only three non-test files under src/ can reach the ops counter — every case above assumes that scope', () => {
    // Ledgers files that REACH the handle, not ones that spell `.inc`. A spelled guard is
    // walkable: `const c = appStorageOpsCounter; c.inc(…)`, `.labels(op, outcome).inc()` (live
    // production idiom in `flipt-eval-cache.metrics.ts`) and `inc.call(…)` are all first-class
    // prom-client usage that a `/appStorageOpsCounter\s*\.inc/` pattern misses — measured, all
    // three evaded it with an untyped `outcome`.
    //
    // Two reach-paths, so two patterns: the symbol (which any importer must name) and the WIRE
    // NAME via `register.getSingleMetric(...)`, which needs no import at all — this file itself
    // obtains a writable handle that way, so "a writer cannot avoid naming the symbol" would be
    // false as a claim about the program. Fails on growth AND shrink.
    //
    // 🔴 Title says "under src/" deliberately: the walk root is `src/`, so a writer added under
    // `packages/` or `apps/` is invisible here. `packages/civitai-telemetry/src/client.ts` is a
    // fourth referencing file for exactly that reason — it is the declaration, and benign.
    // `__tests__` is excluded: a suite that stubs the handle is not a production writer, which
    // is why this set is three and not the EIGHT a test-inclusive walk reports. (Seven is the
    // figure under the symbol-only predicate — i.e. before the wire-name pattern three lines
    // above existed. The eighth is `metrics-endpoint-seeds-app-block-storage.test.ts`, which
    // matches on the wire name and never names the symbol: measured bySym=7, byWire=2,
    // either=8. A count that silently belonged to the previous version of its own predicate is
    // the whole hazard this file exists to catch, so it is spelled out rather than restated.)
    // `block-token-access.service.ts` names it in a comment only, and that is still the right
    // membership test, because the claim is about what can reach the counter.
    const reaching: string[] = [];
    const sites: Record<string, number> = {};
    const occurrences: Record<string, number> = {};
    const perSymbol: Record<string, Record<string, number>> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('appStorageOpsCounter') || text.includes(OPS)) {
            const rel = path.relative(SRC, full);
            reaching.push(rel);
            sites[rel] = (
              text.match(/appStorageOpsCounter\s*(?:\.\w+\([^)]*\))?\s*\.inc\b/g) ?? []
            ).length;
            // Comments stripped first: these files DISCUSS the handle in their docstrings, so
            // a raw count reads 4 for the service and would false-fail on a prose edit —
            // turning a guard about reachability into one about wording.
            const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
            for (const sym of LEDGERED_WRITERS) {
              perSymbol[sym] ??= {};
              perSymbol[sym][rel] = (code.match(new RegExp(`\\b${sym}\\b`, 'g')) ?? []).length;
            }
            occurrences[rel] = perSymbol.appStorageOpsCounter[rel];
          }
        }
      }
    };
    walk(SRC);
    expect(reaching.sort()).toEqual([
      'server/prom/app-block-storage.metrics.ts',
      'server/services/apps/app-storage.service.ts',
      'server/services/blocks/block-token-access.service.ts',
    ]);

    // 🔴 Per-file membership is not enough on its own: the service is permanently on that list
    // because it holds `countStorageOutcome`'s own `.inc`, so a SECOND raw emit added inside it
    // — the likeliest place one appears — passes the set check. Measured: it survived.
    //
    // 🔴 But a `.inc` SITE count is itself a spelling, and it is walkable by exactly two of the
    // three evasions this case's own comment enumerates: `const c = appStorageOpsCounter;
    // c.inc(…)` and `inc.call(appStorageOpsCounter, …)` both leave the count at 1 inside an
    // already-listed file. So the invariant is asserted on OCCURRENCES of the symbol, which an
    // alias or a `.call` must add to: two CODE occurrences in each writer (the import and the
    // one use), and zero in `block-token-access.service.ts` — which is in the membership set on
    // a docstring mention alone, so a first real emit there would otherwise be uncounted.
    const SERVICE_REL = 'server/services/apps/app-storage.service.ts';
    const SEEDER_REL = 'server/prom/app-block-storage.metrics.ts';
    expect(sites[SERVICE_REL], `${SERVICE_REL} .inc sites`).toBe(1);
    expect(sites[SEEDER_REL], `${SEEDER_REL} .inc sites`).toBe(1);
    expect(sites['server/services/blocks/block-token-access.service.ts'], 'comment-only file').toBe(
      0
    );

    // 🔴 All THREE counters, not just the ops one. The asymmetry was the gap: the quota counter
    // is the one with the alerting consumer AND the one whose typo is worse than absence, yet
    // it had no writer ledger at all — so `countQuotaExceeded` was bypassable at any new site
    // and invisible on both axes. Measured: a raw
    // `appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId, ceiling: 'User' })`
    // replacing one wrapper call left typecheck at 4 errors and the suite 17/17 green, because
    // `registerCounterWithLabels` parameterises label NAMES only — prom-client types a label
    // VALUE as `string | number`, so skipping the helper violates no type.
    for (const sym of LEDGERED_WRITERS) {
      expect(perSymbol[sym]?.[SERVICE_REL], `${sym} in the service`).toBe(2);
      expect(perSymbol[sym]?.[SEEDER_REL], `${sym} in the seeder`).toBe(2);
    }
  });
});
