import promClient from 'prom-client';
import { describe, expect, it } from 'vitest';

import {
  PROM_PREFIX,
  appStorageLatencyHistogram,
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
  appStorageUserQuotaUntrackedCounter,
} from '../client';

/**
 * NAME LEDGER for the four App Blocks KV storage metrics.
 *
 * 🔴 WHY A LEDGER AND NOT A HEURISTIC. The declared names in `../client` are
 * PREFIX-RELATIVE — the register helpers construct with `PROM_PREFIX + name` —
 * and these four were declared already carrying `app_blocks_`, so the wire names
 * stuttered: `civitai_app_app_blocks_storage_ops_total`. That shipped and was
 * scraped for months. The sibling guard `prom-prefix-not-doubled.test.ts`
 * CANNOT see it: it rejects only a literal `PROM_PREFIX + PROM_PREFIX`, and
 * `civitai_app_app_blocks_…` passes it cleanly. Widening that heuristic is not
 * the fix — a heuristic can only reject the shapes someone imagined. The fix is
 * to pin the EXACT exposed strings, which is a machine-checkable claim about the
 * only thing an operator can actually query.
 *
 * 🔴 Asserted against the REAL default registry, never against the source
 * literal. The declared name is half the exposed name; a test that read the
 * literal would be green on exactly the defect this file exists to catch.
 * Importing `../client` is what performs the registrations.
 *
 * This is also the ONLY layer where these names are checkable at all. Every
 * app-side consumer imports them through `~/server/prom/client`, which
 * `src/__tests__/setup.ts` replaces wholesale with `vi.fn()` stubs — so no
 * app-side assertion can see a metric name, correct or not.
 */

// Literal, not derived from PROM_PREFIX or from the declarations. These are the
// strings an operator types into Grafana and into a PrometheusRule; deriving
// them would make this file agree with whatever the code does.
const OPS = 'civitai_app_block_storage_ops_total';
const QUOTA_EXCEEDED = 'civitai_app_block_storage_quota_exceeded_total';
const USER_QUOTA_UNTRACKED = 'civitai_app_block_storage_user_quota_untracked_total';
const LATENCY = 'civitai_app_block_storage_latency_seconds';

/** The pre-fix stuttering spellings. Retired 2026-10-02; must never come back. */
const OLD_NAMES = [
  'civitai_app_app_blocks_storage_ops_total',
  'civitai_app_app_blocks_storage_quota_exceeded_total',
  'civitai_app_app_blocks_storage_user_quota_untracked_total',
  'civitai_app_app_blocks_storage_latency_seconds',
];

describe('App Blocks storage metric names', () => {
  it('exposes exactly these four names on the default registry', () => {
    for (const name of [OPS, QUOTA_EXCEEDED, USER_QUOTA_UNTRACKED, LATENCY]) {
      expect(promClient.register.getSingleMetric(name), name).toBeDefined();
    }

    // Fails on GROWTH too, not only on a rename: a fifth `block_storage_*` metric would
    // otherwise join the family with its exposed name pinned nowhere.
    const family = promClient.register
      .getMetricsAsArray()
      .map((m) => (m as { name: string }).name)
      .filter((n) => n.startsWith('civitai_app_block_storage_'));
    expect(family.sort()).toEqual([LATENCY, OPS, QUOTA_EXCEEDED, USER_QUOTA_UNTRACKED].sort());
  });

  it('the exported handles ARE those four metrics — not same-named strangers', () => {
    // Pins handle -> name. Without this, the case above stays green if someone
    // registers these names from somewhere else while the handles the service
    // actually calls `.inc()` on keep stuttering.
    expect((appStorageOpsCounter as unknown as { name: string }).name).toBe(OPS);
    expect((appStorageQuotaExceededCounter as unknown as { name: string }).name).toBe(
      QUOTA_EXCEEDED
    );
    expect((appStorageUserQuotaUntrackedCounter as unknown as { name: string }).name).toBe(
      USER_QUOTA_UNTRACKED
    );
    expect((appStorageLatencyHistogram as unknown as { name: string }).name).toBe(LATENCY);
  });

  it('🔴 the stuttering pre-fix names are gone', () => {
    const names = promClient.register.getMetricsAsArray().map((m) => (m as { name: string }).name);
    // Positive control: the import really did register this package's metrics,
    // so an empty intersection below means "the old names are absent", not
    // "the registry is empty".
    expect(names.filter((n) => n.startsWith(PROM_PREFIX)).length).toBeGreaterThan(10);
    expect(names.filter((n) => OLD_NAMES.includes(n))).toEqual([]);
  });

  it('declares the label sets an operator queries by', () => {
    // Asserted against DECLARED labelNames, not emitted series: prom-client
    // omits a declared-but-never-supplied label from its output, so inspecting
    // emitted labels stays green on a metric declared wide open.
    //
    // `?? {}` on the metric, not just on `labelNames`: this is the file whose job is a legible
    // name failure, and reading a field off `undefined` throws a TypeError instead.
    const declared = (name: string) =>
      [
        ...((
          (promClient.register.getSingleMetric(name) ?? {}) as unknown as {
            labelNames?: string[];
          }
        ).labelNames ?? []),
      ].sort();
    expect(declared(OPS)).toEqual(['op', 'outcome']);
    expect(declared(QUOTA_EXCEEDED)).toEqual(['app_block_id', 'ceiling']);
    expect(declared(USER_QUOTA_UNTRACKED)).toEqual(['app_block_id']);
    expect(declared(LATENCY)).toEqual(['op']);
  });

  it('🔴 pins the latency buckets — a boundary change silently reshapes every quantile on it', () => {
    // Same unguessable-from-outside property the names had: nothing outside this repo can see
    // a bucket edit, and `histogram_quantile` over a moved boundary just returns a different
    // number. The 5 children x 13 series arithmetic in the seeding test also rests on this.
    const buckets = (
      promClient.register.getSingleMetric(LATENCY) as unknown as { upperBounds: number[] }
    ).upperBounds;
    expect([...buckets]).toEqual([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]);
  });

  it('no metric in this package repeats the `app_` segment the prefix already supplies', () => {
    // Narrow by design, and NOT a replacement for the ledger above: it pins the
    // one collision that actually exists in this corpus — a declared name
    // starting `app_` under a `civitai_app_` prefix. A declared name that
    // repeats some OTHER segment still needs a ledger entry.
    const names = promClient.register.getMetricsAsArray().map((m) => (m as { name: string }).name);
    expect(names.filter((n) => n.startsWith(PROM_PREFIX)).length).toBeGreaterThan(10);
    expect(names.filter((n) => n.startsWith(`${PROM_PREFIX}app_`))).toEqual([]);
  });
});
