import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_SURFACES,
  MODEL_SUBSTITUTION_REASONS,
  createModelSubstitutionCollector,
  type GenerationSurface,
  type ModelSubstitutionReason,
} from '~/shared/data-graph/generation/model-substitution';
import { emitModelSubstitutions } from '../emit-model-substitutions';
import {
  ensureRegisterGenerationModelSubstitutionMetrics,
  recordGenerationModelSubstitution,
} from '../generation-model-substitution.metrics';

/**
 * The REAL prom-client side of the silent-checkpoint-SUBSTITUTION signal
 * (issue #3520, phase 1), plus the drain helper the generation path calls.
 *
 * Two failure classes are pinned here that a graph-level test structurally
 * cannot see:
 *
 *   1. A metric-name or label-name typo. That sails through every test that
 *      mocks this module and yields an alert rule which silently never fires —
 *      the exact failure class this signal exists to prevent. So this file
 *      drives the real default registry.
 *   2. 🔴 A throw escaping into the generation path. This emits on a SUCCESSFUL
 *      generation submit (the substitution is a success, not a rejection), so an
 *      unguarded prom-client error here would turn a working generation into a
 *      500 — observability causing the outage.
 *
 * 🔴 CARDINALITY is the other load-bearing property: `reason` (3 values) x
 * `surface` (3 values) = 9 series, total, forever, across ~130 scraped pods
 * where prom-client retains every distinct label set in the Node heap for the
 * process lifetime. Widening it has to get past these tests.
 *
 * 🔴 SURFACE is load-bearing for a different reason: `validateInput` is shared
 * by the on-site generator, the App Blocks bridge and preset generation, and
 * #3520 calls the substitution CORRECT on-site and unobservable through the
 * bridge. Summed into one series the counter measures a contaminated quantity,
 * which is exactly what phase 2 is supposed to produce a clean number for.
 */

const METRIC = 'civitai_generation_model_substitutions_total';

async function readSeries(reason: string, surface: string): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return values.find((v) => v.labels.reason === reason && v.labels.surface === surface)?.value ?? 0;
}

/** Sum across surfaces — the CONTAMINATED read the surface label exists to split. */
async function readReasonAcrossSurfaces(reason: string): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return values.filter((v) => v.labels.reason === reason).reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  // `clear()` (not `resetMetrics()`): one case deliberately registers a POISONED
  // metric under this name, and a values-only reset would leak it into every
  // later case.
  client.register.clear();
});

describe('civitai_generation_model_substitutions_total', () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterGenerationModelSubstitutionMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it.each(
    MODEL_SUBSTITUTION_REASONS.flatMap((reason) =>
      GENERATION_SURFACES.map(
        (surface) => [reason, surface] as [ModelSubstitutionReason, GenerationSurface]
      )
    )
  )('increments the (`%s`, `%s`) series', async (reason, surface) => {
    recordGenerationModelSubstitution(reason, surface);
    expect(await readSeries(reason, surface)).toBe(1);
  });

  it('🔴 the SURFACES are separate series — on-site (correct) never inflates the block number', async () => {
    // The whole point of the label. #3520 defends the on-site substitution as
    // intended behaviour and indicts the bridge one; phase 3's decision is gated
    // on the BLOCK incidence, so an un-split counter would report a number that
    // is mostly the case nobody wants to change.
    recordGenerationModelSubstitution('unrecognized', 'onsite');
    recordGenerationModelSubstitution('unrecognized', 'onsite');
    recordGenerationModelSubstitution('unrecognized', 'onsite');
    recordGenerationModelSubstitution('unrecognized', 'block');
    recordGenerationModelSubstitution('unrecognized', 'preset');

    expect(await readSeries('unrecognized', 'block')).toBe(1);
    expect(await readSeries('unrecognized', 'onsite')).toBe(3);
    expect(await readSeries('unrecognized', 'preset')).toBe(1);
    // …and the contaminated read the split exists to avoid.
    expect(await readReasonAcrossSurfaces('unrecognized')).toBe(5);
  });

  it.each([
    ['undefined', undefined],
    ['an unknown surface', 'cli'],
    ['a number', 7],
  ])(
    '🔴 DROPS an increment whose surface is %s — the label set stays bounded',
    async (_l, bogus) => {
      recordGenerationModelSubstitution('unrecognized', bogus as never as GenerationSurface);
      expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
    }
  );

  it.each([
    ['undefined', undefined],
    ['an unknown reason', 'because'],
  ])('🔴 DROPS an increment whose reason is %s', async (_l, bogus) => {
    recordGenerationModelSubstitution(bogus as never as ModelSubstitutionReason, 'block');
    expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
  });

  it('🔴 the reasons are SEPARATE series — an entitlement swap never reads as a wrong-mode swap', async () => {
    // The three reasons demand different responses: `wrong-workflow` is an
    // app-authoring bug, `unrecognized` is a retired/unknown model (the case
    // degradation exists to survive), `gated` is an entitlement decision. One
    // undifferentiated counter would send an operator to the wrong place.
    recordGenerationModelSubstitution('wrong-workflow', 'block');
    recordGenerationModelSubstitution('unrecognized', 'block');
    recordGenerationModelSubstitution('unrecognized', 'block');
    recordGenerationModelSubstitution('gated', 'block');

    expect(await readSeries('wrong-workflow', 'block')).toBe(1);
    expect(await readSeries('unrecognized', 'block')).toBe(2);
    expect(await readSeries('gated', 'block')).toBe(1);
  });

  it('🔴 DECLARES exactly `reason` + `surface` — the cardinality bound is structural', async () => {
    // 🔴 Asserted against the DECLARED `labelNames`, NOT the emitted series.
    // prom-client omits a declared-but-never-supplied label from its output, so
    // inspecting `values[].labels` stays green while the metric is declared wide
    // open — and the next caller to pass a version id blows the budget with
    // nothing ever having failed.
    ensureRegisterGenerationModelSubstitutionMetrics();
    const metric = client.register.getSingleMetric(METRIC) as unknown as { labelNames: string[] };
    expect([...metric.labelNames].sort()).toEqual(['reason', 'surface']);

    recordGenerationModelSubstitution('unrecognized', 'block');
    const emitted = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await emitted.get();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(Object.keys(v.labels).sort()).toEqual(['reason', 'surface']);
  });

  it('🔴 both unions are EXACTLY these values — 3 x 3 = 9 series is the whole budget', () => {
    // Literal, not derived: the reason union is simultaneously the metric label
    // AND the `BlockWorkflowSnapshot.modelSubstitutions[].reason` wire contract,
    // so a fourth value added on either side has to come through here. The
    // surface union bounds the other axis.
    expect([...MODEL_SUBSTITUTION_REASONS]).toEqual(['wrong-workflow', 'unrecognized', 'gated']);
    expect([...GENERATION_SURFACES]).toEqual(['block', 'onsite', 'preset']);
  });

  it('🔴 emits AT MOST 9 series no matter how many substitutions land', async () => {
    for (let i = 0; i < 100; i++) {
      for (const reason of MODEL_SUBSTITUTION_REASONS) {
        for (const surface of GENERATION_SURFACES) {
          recordGenerationModelSubstitution(reason, surface);
        }
      }
    }
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values).toHaveLength(9);
    expect(await readSeries('wrong-workflow', 'block')).toBe(100);
  });

  it('is idempotent to register — a double module import does not throw', () => {
    expect(() => {
      ensureRegisterGenerationModelSubstitutionMetrics();
      ensureRegisterGenerationModelSubstitutionMetrics();
    }).not.toThrow();
  });

  it('appears in the scrape output under its exact name, with both labels', async () => {
    recordGenerationModelSubstitution('gated', 'block');
    const scrape = await client.register.metrics();
    expect(scrape).toContain(METRIC);
    expect(scrape).toContain(`${METRIC}{reason="gated",surface="block"}`);
  });

  it('🔴 the emitter NEVER throws — a broken registry cannot fail a generation', () => {
    // Poison the default registry: something already registered under this name
    // with a DIFFERENT labelset (the shape a name collision takes). The
    // get-or-create guard hands that instance back and prom-client then throws
    // on `.inc({ reason })` because `reason` was never declared on it.
    new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });

    expect(() => recordGenerationModelSubstitution('unrecognized', 'block')).not.toThrow();
  });

  it('the poisoned-registry case really would throw unguarded (the guard is reachable)', () => {
    // Proves the case above is not vacuous: the underlying prom-client call DOES
    // throw, so `not.toThrow()` there is testing the guard rather than an inert
    // no-op.
    const poisoned = new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });
    expect(() => poisoned.inc({ reason: 'unrecognized', surface: 'block' })).toThrow();
  });
});

describe('emitModelSubstitutions — the drain the generation path calls', () => {
  function collectorWith(surface: GenerationSurface, ...reasons: ModelSubstitutionReason[]) {
    let i = 0;
    const collector = createModelSubstitutionCollector(() => reasons[i++], surface);
    reasons.forEach((_, n) =>
      collector.record({ requested: 1000 + n, applied: 1, ecosystem: 'Qwen', workflow: 'txt2img' })
    );
    return collector;
  }

  it('emits one increment per recorded substitution, with the reason recorded', async () => {
    await emitModelSubstitutions(
      collectorWith('block', 'wrong-workflow', 'unrecognized', 'unrecognized')
    );
    expect(await readSeries('wrong-workflow', 'block')).toBe(1);
    expect(await readSeries('unrecognized', 'block')).toBe(2);
  });

  it("🔴 labels every increment with the COLLECTOR's surface, not a guess", async () => {
    // The emitter sits inside `validateInput`, which is shared by all three
    // surfaces; the only surface information that exists at that point is the one
    // the caller fixed when it built the context. Two collectors, two surfaces,
    // same reason — they must not merge.
    await emitModelSubstitutions(collectorWith('onsite', 'unrecognized'));
    await emitModelSubstitutions(collectorWith('preset', 'unrecognized'));

    expect(await readSeries('unrecognized', 'onsite')).toBe(1);
    expect(await readSeries('unrecognized', 'preset')).toBe(1);
    expect(await readSeries('unrecognized', 'block')).toBe(0);
  });

  it('🔴 a SECOND drain of the same collector emits nothing — no double-counting', async () => {
    const collector = collectorWith('block', 'wrong-workflow');
    await emitModelSubstitutions(collector);
    await emitModelSubstitutions(collector);
    expect(await readSeries('wrong-workflow', 'block')).toBe(1);
  });

  it('emits nothing when nothing was substituted (an alert on this must mean something)', async () => {
    await emitModelSubstitutions(createModelSubstitutionCollector(() => 'unrecognized', 'block'));
    expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
  });

  it('tolerates an ABSENT collector (the client-side context has none)', async () => {
    await expect(emitModelSubstitutions(undefined)).resolves.toBeUndefined();
  });

  it('🔴 RESOLVES even when the metrics module is poisoned — it never rejects into the request', async () => {
    // `validateInput` calls this with `void`; an unhandled rejection here would
    // be an unhandled rejection on the generation submit path.
    new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });
    await expect(emitModelSubstitutions(collectorWith('block', 'gated'))).resolves.toBeUndefined();
  });

  it('🔴 RESOLVES when the collector itself throws on drain', async () => {
    // Covers the `await import` / destructure side of the guard too: the throw
    // happens before the metrics module is ever reached.
    const broken = {
      surface: 'block' as const,
      record: vi.fn(),
      list: vi.fn(() => []),
      takeUnemitted: vi.fn(() => {
        throw new Error('collector exploded');
      }),
    };
    await expect(emitModelSubstitutions(broken)).resolves.toBeUndefined();
    expect(broken.takeUnemitted).toHaveBeenCalled();
  });
});
