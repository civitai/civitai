import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_BLOCK_SUCCEEDED_WITHOUT_MEDIA_REASONS,
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
async function read(stepType: string, reason = 'absent'): Promise<number> {
  const m = metric();
  if (!m) return Number.NaN;
  return (
    (await m.get()).values.find(
      (v) => v.labels.step_type === stepType && v.labels.reason === reason
    )?.value ?? 0
  );
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

  it('increments the (step_type, reason) it was called with, and only that one', async () => {
    recordSucceededWithoutMedia('comfy', 'absent');
    recordSucceededWithoutMedia('comfy', 'absent');
    recordSucceededWithoutMedia('comfy', 'unavailable');
    recordSucceededWithoutMedia('passthrough', 'absent');
    expect(await read('comfy', 'absent')).toBe(2);
    expect(await read('comfy', 'unavailable')).toBe(1);
    expect(await read('passthrough', 'absent')).toBe(1);
    expect(await read('imageGen', 'absent')).toBe(0);
  });

  it('DECLARES exactly two labels, `step_type` and a closed two-value `reason`', () => {
    // Against the DECLARED labelNames: prom-client omits a declared-but-unsupplied
    // label from its output, so emitted series alone cannot show a widened metric.
    ensureRegisterAppBlockRuntimeMetrics();
    expect([...(metric() as Readable).labelNames]).toEqual(['step_type', 'reason']);
    expect([...APP_BLOCK_SUCCEEDED_WITHOUT_MEDIA_REASONS]).toEqual(['absent', 'unavailable']);
  });

  it('a second registration reuses the existing metric instead of throwing', async () => {
    ensureRegisterAppBlockRuntimeMetrics();
    recordSucceededWithoutMedia('comfy', 'absent');
    expect(() => ensureRegisterAppBlockRuntimeMetrics()).not.toThrow();
    expect(await read('comfy')).toBe(1);
  });

  it('the emitter NEVER throws — a broken registry cannot fail the poll', () => {
    new client.Counter({ name: METRIC, help: 'poisoned', labelNames: ['other'] });
    expect(() => recordSucceededWithoutMedia('comfy', 'absent')).not.toThrow();
  });
});
