import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_BLOCK_POST_SURFACES,
  ensureRegisterAppBlockRuntimeMetrics,
  recordBlockPostSubjectRefusal,
  type AppBlockPostSurface,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the post-from-app UNREADABLE-SUBJECT signal.
 *
 * ⚠️ LABEL THIS FILE HONESTLY: it is NOT regression coverage. The counter it checks
 * does not exist on the pre-change tree, so nothing here can be watched failing against
 * a build that had the defect — these are guards on a brand-new surface. The regression
 * matrix belongs to the router cases in
 * `src/server/routers/__tests__/blocks.router.createPostFromApp.test.ts`, which run
 * against both trees.
 *
 * WHY IT EXISTS ANYWAY, in the words its three siblings already use for this class: the
 * router-level test proves the preamble CALLS the emitter on the refusal path. It cannot
 * prove the emitter produces a SCRAPEABLE SERIES with the right name and the right label.
 * A metric-name typo or a label-name mismatch sails straight through that test and yields
 * an alert rule that silently never fires.
 *
 * 🔴 AND THIS EMITTER IS THE WORST CASE FOR THAT, for three compounding reasons:
 *   - It is `try { … } catch {}` by design (a metrics error must never convert a refusal
 *     the preamble already settled into a 500), so a registration or label defect
 *     produces ZERO and never throws. Nothing anywhere would go red.
 *   - A flat zero is ALSO the healthy steady state — a subject that hydrates never
 *     reaches the emitter. So "the counter is inert" and "the fleet is fine" are the same
 *     observation, and no amount of watching the series can separate them.
 *   - 🔴 There is no second surface to fall back on. Application-container logs are not
 *     collected for this deployment, so unlike every other refusal in this router there
 *     is no log line an investigator can read instead. If this series is broken, the
 *     branch is exactly as unobservable as it was before the fix — which is the state
 *     that left the 2026-09-19 refusal unattributable to any mechanism.
 *
 * 🔴 The cardinality bound is the other load-bearing property, same as the siblings. One
 * label over a 2-value code-owned union = 2 series, total, forever. prom-client retains
 * every distinct label set in the Node heap for the process lifetime across every scraped
 * pod, so widening this is a code change that has to get past these tests.
 */

const METRIC = 'civitai_app_block_post_subject_refusals_total';

/** Read one `{surface}` series' current value from the default registry. */
async function readSurface(surface: string): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return values.find((v) => v.labels.surface === surface)?.value ?? 0;
}

beforeEach(() => {
  // `clear()` (not `resetMetrics()`), matching the sibling suites: a fully empty default
  // registry makes each case order-independent even when one of them registers something
  // under this name itself.
  client.register.clear();
});

describe(METRIC, () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it.each(APP_BLOCK_POST_SURFACES.map((s) => [s] as [AppBlockPostSurface]))(
    'increments the `%s` series',
    async (surface) => {
      recordBlockPostSubjectRefusal(surface);
      expect(await readSurface(surface)).toBe(1);
    }
  );

  it('🔴 keeps the two surfaces SEPARATE — a create refusal never lands on preview', async () => {
    // The split is the whole value of the label. A refused `create` is a post the viewer
    // intended to make and did not get; a refused `preview` cost them a dialog. Summed
    // across the label those are one number with no operational meaning.
    recordBlockPostSubjectRefusal('create');
    recordBlockPostSubjectRefusal('create');
    recordBlockPostSubjectRefusal('preview');

    expect(await readSurface('create')).toBe(2);
    expect(await readSurface('preview')).toBe(1);
  });

  it('carries ONLY `surface` — no app, block-instance or user label', async () => {
    // Cardinality bound, pinned rather than commented. This fires once per refused
    // attempt with nothing caching it; an id-shaped label here is the Node-heap growth
    // class the module header calls out.
    recordBlockPostSubjectRefusal('create');
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(Object.keys(v.labels).sort()).toEqual(['surface']);
  });

  it('NEGATIVE CONTROL: it does not throw when the registry is poisoned, and the caller survives', () => {
    // The emitter is deliberately fail-soft — the refusal is already decided by the time
    // it runs, and a metrics error must not turn a chosen 401 into an uncaught 500. This
    // is also why a broken emitter is silent, and therefore why every case above has to
    // be a real scrape rather than a spy on the call.
    client.register.registerMetric(
      new client.Gauge({ name: METRIC, help: 'poisoned — wrong type, same name' })
    );
    expect(() => recordBlockPostSubjectRefusal('create')).not.toThrow();
  });
});
