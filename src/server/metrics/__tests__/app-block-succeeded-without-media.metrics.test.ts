import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ensureRegisterAppBlockRuntimeMetrics,
  recordSucceededWithoutMedia,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of `civitai_app_block_succeeded_without_media_total`.
 * When it is emitted is `blocks.router.succeededWithoutMedia.test.ts`'s job; this
 * file pins the name, the declared label set, the duplicate-registration guard and
 * that the emitter never throws.
 */

const METRIC = 'civitai_app_block_succeeded_without_media_total';

type Readable = {
  labelNames: string[];
  get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
};
const metric = () => client.register.getSingleMetric(METRIC) as unknown as Readable | undefined;
async function read(stepType: string): Promise<number> {
  const m = metric();
  if (!m) return Number.NaN;
  return (await m.get()).values.find((v) => v.labels.step_type === stepType)?.value ?? 0;
}

beforeEach(() => {
  client.register.clear();
});

describe(METRIC, () => {
  it('is registered on the default registry, and is zero until something is counted', async () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(metric()).toBeDefined();
    expect(await read('comfy')).toBe(0);
  });

  it('increments the step_type it was called with, and only that one', async () => {
    recordSucceededWithoutMedia('comfy');
    recordSucceededWithoutMedia('comfy');
    recordSucceededWithoutMedia('passthrough');
    expect(await read('comfy')).toBe(2);
    expect(await read('passthrough')).toBe(1);
    expect(await read('imageGen')).toBe(0);
  });

  it('DECLARES exactly one label, `step_type`', () => {
    // Against the DECLARED labelNames: prom-client omits a declared-but-unsupplied
    // label from its output, so emitted series alone cannot show a widened metric.
    ensureRegisterAppBlockRuntimeMetrics();
    expect([...(metric() as Readable).labelNames]).toEqual(['step_type']);
  });

  it('a second registration reuses the existing metric instead of throwing', async () => {
    ensureRegisterAppBlockRuntimeMetrics();
    recordSucceededWithoutMedia('comfy');
    expect(() => ensureRegisterAppBlockRuntimeMetrics()).not.toThrow();
    expect(await read('comfy')).toBe(1);
  });

  it('the emitter NEVER throws — a broken registry cannot fail the poll', () => {
    new client.Counter({ name: METRIC, help: 'poisoned', labelNames: ['other'] });
    expect(() => recordSucceededWithoutMedia('comfy')).not.toThrow();
  });
});
