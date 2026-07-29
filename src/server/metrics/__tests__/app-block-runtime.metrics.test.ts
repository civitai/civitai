import { describe, expect, it } from 'vitest';
import client from 'prom-client';

/**
 * Direct unit coverage for the two customComfy per-engine runtime/cost metric
 * helpers (`observeCustomComfyActualBuzz` / `observeCustomComfyWallclockSeconds`).
 *
 * The settle-service test mocks these at the module boundary, so their OWN
 * input-filtering + never-throw contract had no direct coverage. These tests
 * exercise the REAL helpers against the REAL default prom-client registry (the
 * same registry /api/metrics scrapes) and read the histogram back, so they pin:
 *   - the `<= 0` / `NaN` drop (both helpers),
 *   - the `> MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS` drop (wall-clock only — Finding 2),
 *   - a valid in-range value IS observed with the right {engine, recipe} labels,
 *   - neither helper ever throws on bad input (the internal fail-soft catch).
 */

import {
  MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS,
  observeCustomComfyActualBuzz,
  observeCustomComfyWallclockSeconds,
} from '~/server/metrics/app-block-runtime.metrics';

type HistPoint = { metricName?: string; labels: Record<string, string>; value: number };

/**
 * Read back a single histogram aggregate (`_count` or `_sum`) for one
 * {engine, recipe} label pair from the default registry. Returns 0 when the
 * series doesn't exist yet — lets every assertion use a before/after DELTA so
 * the tests are order-independent (the registry is process-global and other
 * suites may have already observed samples).
 */
async function readHist(
  name: string,
  suffix: '_count' | '_sum',
  engine: string,
  recipe: string
): Promise<number> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return 0;
  const data = await (metric as { get(): Promise<{ values: HistPoint[] }> }).get();
  const match = data.values.find(
    (v) =>
      v.metricName?.endsWith(suffix) &&
      v.labels.engine === engine &&
      v.labels.recipe === recipe
  );
  return match?.value ?? 0;
}

const ACTUAL_METRIC = 'civitai_app_block_customcomfy_actual_buzz';
const WALLCLOCK_METRIC = 'civitai_app_block_customcomfy_wallclock_seconds';
const RECIPE = 'seamless-pano-360';

describe('observeCustomComfyActualBuzz', () => {
  it('observes a valid value with the right engine/recipe labels', async () => {
    const engine = 'zimage-turbo';
    const beforeCount = await readHist(ACTUAL_METRIC, '_count', engine, RECIPE);
    const beforeSum = await readHist(ACTUAL_METRIC, '_sum', engine, RECIPE);

    observeCustomComfyActualBuzz(engine, RECIPE, 42);

    expect(await readHist(ACTUAL_METRIC, '_count', engine, RECIPE)).toBe(beforeCount + 1);
    expect(await readHist(ACTUAL_METRIC, '_sum', engine, RECIPE)).toBe(beforeSum + 42);
  });

  it('DROPS a zero / negative / NaN value (no sample recorded)', async () => {
    const engine = 'flux2-klein';
    const beforeCount = await readHist(ACTUAL_METRIC, '_count', engine, RECIPE);

    observeCustomComfyActualBuzz(engine, RECIPE, 0);
    observeCustomComfyActualBuzz(engine, RECIPE, -5);
    observeCustomComfyActualBuzz(engine, RECIPE, Number.NaN);

    expect(await readHist(ACTUAL_METRIC, '_count', engine, RECIPE)).toBe(beforeCount);
  });

  it('never throws on bad input', () => {
    expect(() => observeCustomComfyActualBuzz('qwen-image', RECIPE, Infinity)).not.toThrow();
    expect(() =>
      observeCustomComfyActualBuzz('qwen-image', RECIPE, undefined as unknown as number)
    ).not.toThrow();
  });
});

describe('observeCustomComfyWallclockSeconds', () => {
  it('observes an in-range value with the right engine/recipe labels', async () => {
    const engine = 'zimage-turbo';
    const beforeCount = await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE);
    const beforeSum = await readHist(WALLCLOCK_METRIC, '_sum', engine, RECIPE);

    observeCustomComfyWallclockSeconds(engine, RECIPE, 37);

    expect(await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE)).toBe(beforeCount + 1);
    expect(await readHist(WALLCLOCK_METRIC, '_sum', engine, RECIPE)).toBe(beforeSum + 37);
  });

  it('DROPS a zero / negative / NaN value', async () => {
    const engine = 'flux2-klein';
    const beforeCount = await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE);

    observeCustomComfyWallclockSeconds(engine, RECIPE, 0);
    observeCustomComfyWallclockSeconds(engine, RECIPE, -1);
    observeCustomComfyWallclockSeconds(engine, RECIPE, Number.NaN);

    expect(await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE)).toBe(beforeCount);
  });

  it('DROPS a value above MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS (Finding 2 — junk delta)', async () => {
    const engine = 'qwen-image';
    const beforeCount = await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE);
    const beforeSum = await readHist(WALLCLOCK_METRIC, '_sum', engine, RECIPE);

    // A junk value from clock skew / stale submittedAt — dropped, not clamped, so
    // it can't pollute `_sum` or the tail quantiles.
    observeCustomComfyWallclockSeconds(engine, RECIPE, MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS + 1);

    expect(await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE)).toBe(beforeCount);
    expect(await readHist(WALLCLOCK_METRIC, '_sum', engine, RECIPE)).toBe(beforeSum);
  });

  it('observes a value exactly at the MAX boundary (inclusive)', async () => {
    const engine = 'qwen-image';
    const beforeCount = await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE);

    observeCustomComfyWallclockSeconds(engine, RECIPE, MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS);

    expect(await readHist(WALLCLOCK_METRIC, '_count', engine, RECIPE)).toBe(beforeCount + 1);
  });

  it('never throws on bad input', () => {
    expect(() =>
      observeCustomComfyWallclockSeconds('qwen-image', RECIPE, Infinity)
    ).not.toThrow();
    expect(() =>
      observeCustomComfyWallclockSeconds('qwen-image', RECIPE, undefined as unknown as number)
    ).not.toThrow();
  });
});
