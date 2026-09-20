import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ensureRegisterAppBlockRuntimeMetrics,
  recordBlockBridgeRateLimitRefusal,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the App Blocks tRPC-bridge rate-limit refusal signal.
 *
 * ⚠️ LABEL THIS FILE HONESTLY, as its siblings do: it is NOT regression coverage. The
 * counter does not exist on the pre-change tree, so nothing here can be watched failing
 * against a build that had the defect. These are guards on a brand-new surface. The
 * regression matrix belongs to
 * `src/server/routers/__tests__/blocks.router.bridgeRateLimits.test.ts`, which runs
 * against both trees.
 *
 * WHY IT EXISTS ANYWAY: the router tests prove each limiter site CALLS this emitter on
 * its refusal path. They cannot prove the emitter produces a SCRAPEABLE SERIES with the
 * right name and the right labels. A metric-name typo or a label mismatch sails straight
 * through them and yields a dashboard that silently never moves.
 *
 * 🔴 AND THIS EMITTER IS A BAD CASE FOR THAT, for the reasons its siblings give plus one
 * that is specific to it:
 *   - It is `try { … } catch {}` by design — a metrics error must never convert a refusal
 *     the limiter already settled into a 500, and on the two RETURNING paths
 *     (`pollWorkflow`, `cancelWorkflow`) it must never convert one into a throw at all,
 *     which is precisely what those paths exist to avoid. So a registration or label
 *     defect produces ZERO and never raises.
 *   - A flat zero is ALSO the healthy steady state: a fleet under its ceilings never
 *     reaches the emitter. "The counter is broken" and "nothing is being throttled" are
 *     the same observation from outside.
 *   - 🔴 THE SPECIFIC ONE: this series is the ONLY thing on the platform that counts a
 *     bridge rate-limit event at all. `civitai_app_block_requests_total` is incremented
 *     solely by the REST `withBlockScope` wrapper and never sees a bridge call, and the
 *     bridge writes no `block_scope_invocations` row. Three closing conditions in
 *     `~/server/utils/block-catalog-rate-limit` are written against THIS series existing
 *     and working. If it is inert, every ceiling on that surface stays exactly as
 *     ungradeable as it was before — which is the state the round-0 audit called the
 *     single largest gap in the change.
 *
 * 🔴 The cardinality bound is the other load-bearing property. Both labels are
 * SERVER-CHOSEN constants from the call site, never request input, so a hostile block
 * cannot inflate the label set — prom-client retains every distinct label set in the Node
 * heap for the process lifetime, so widening this has to get past these tests.
 */

const METRIC = 'civitai_app_block_bridge_rate_limit_refusals_total';

/** Read one `{procedure,bucket}` series' current value from the default registry. */
async function read(procedure: string, bucket: string): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return (
    values.find((v) => v.labels.procedure === procedure && v.labels.bucket === bucket)?.value ?? 0
  );
}

beforeEach(() => {
  // `clear()` (not `resetMetrics()`), matching the sibling suites: a fully empty default
  // registry makes each case order-independent.
  client.register.clear();
});

describe(METRIC, () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it('registers itself — the emitter does not need a prior ensureRegister call', async () => {
    // 🔴 THE ORDERING TRAP. Every limiter site calls the emitter directly and none of them
    // calls `ensureRegisterAppBlockRuntimeMetrics` first. If the emitter only incremented an
    // already-registered counter, the first refusal after a cold start would be swallowed by
    // its own `catch` and the series would begin at a silent zero on exactly the pod that
    // was being throttled hardest.
    recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll');
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
    expect(await read('pollWorkflow', 'poll')).toBe(1);
  });

  it('🔴 keeps PROCEDURES separate — a poll refusal never lands on a cancel', async () => {
    // The split is the whole value of the label, and the two differ in what they cost the
    // viewer: a refused poll delays a status update, a refused cancel leaves a paid workflow
    // running. Summed across the label those are one number with no operational meaning.
    recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll');
    recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll');
    recordBlockBridgeRateLimitRefusal('cancelWorkflow', 'catalog');

    expect(await read('pollWorkflow', 'poll')).toBe(2);
    expect(await read('cancelWorkflow', 'catalog')).toBe(1);
  });

  it('🔴 keeps BUCKETS separate — the dedicated poll bucket is legible on its own', async () => {
    // The poll bucket exists precisely so it cannot contend with catalog. If the series
    // merged them, the one question the separation was designed to answer — "is the poll
    // ceiling biting, independently of catalog reads?" — would be unanswerable from the
    // metric, and the argument for the separate bucket would be unverifiable in production.
    recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll');
    recordBlockBridgeRateLimitRefusal('estimateWorkflow', 'catalog');

    expect(await read('pollWorkflow', 'poll')).toBe(1);
    expect(await read('pollWorkflow', 'catalog')).toBe(0);
    expect(await read('estimateWorkflow', 'catalog')).toBe(1);
    expect(await read('estimateWorkflow', 'poll')).toBe(0);
  });

  it('carries ONLY `procedure` and `bucket` — no app, instance or user label', async () => {
    // Cardinality bound, pinned rather than commented. An id-shaped label here is the
    // Node-heap growth class the module header calls out, and on THIS surface it would be
    // attacker-influenced: `blockInstanceId` and the token subject are exactly the values a
    // hostile block controls the volume of.
    recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll');

    const metric = client.register.getSingleMetric(METRIC) as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(Object.keys(v.labels).sort()).toEqual(['bucket', 'procedure']);
    }
  });

  it('NEVER THROWS — a metrics fault must not become a 500, or a throw on a returning path', async () => {
    // 🔴 THE PROPERTY THE TWO RETURNING LIMITERS DEPEND ON. `pollWorkflow` and
    // `cancelWorkflow` return a non-terminal snapshot instead of throwing, because a throw
    // is converted by both hosts into a TERMINAL `failed` snapshot on a paid workflow. If
    // this emitter could throw, it would reintroduce exactly that failure from inside the
    // branch built to avoid it.
    //
    // Driven by breaking the registry rather than by trusting the `catch`: registering a
    // DIFFERENT metric type under the same name makes `getOrCreateCounter` fail for real.
    client.register.clear();
    new client.Gauge({ name: METRIC, help: 'collides on purpose' });

    expect(() => recordBlockBridgeRateLimitRefusal('pollWorkflow', 'poll')).not.toThrow();
  });
});
