import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_BLOCK_CONFIRMED_QUOTE_KINDS,
  ensureRegisterAppBlockRuntimeMetrics,
  recordConfirmedQuoteOvercharge,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the viewer-confirmed quote OVERCHARGE signal.
 *
 * The router suites (`blocks.router.confirmedStep.test.ts`,
 * `blocks.router.trainingKind.test.ts`) mock this module's emitter, which proves the
 * shared submit CALLS it exactly when a submit is billed above what the viewer is
 * charged — and never otherwise. They cannot prove the emitter produces a scrapeable
 * series under the name and label an alert rule will be written against. This file
 * drives the real default registry for that half.
 */

const METRIC = 'civitai_app_block_confirmed_quote_overcharge_total';

type Readable = {
  labelNames: string[];
  get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
};
const metric = () => client.register.getSingleMetric(METRIC) as unknown as Readable | undefined;
async function read(kind: string): Promise<number> {
  const m = metric();
  if (!m) return Number.NaN;
  return (await m.get()).values.find((v) => v.labels.kind === kind)?.value ?? 0;
}

beforeEach(() => {
  // `clear()`, not `resetMetrics()`: one case registers a POISONED metric under this
  // name, and a values-only reset would leak it into every later case.
  client.register.clear();
});

describe('civitai_app_block_confirmed_quote_overcharge_total', () => {
  it('is registered on the default registry, and is zero until something is overcharged', async () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(metric()).toBeDefined();
    expect(await read('step')).toBe(0);
    expect(await read('training')).toBe(0);
  });

  it('increments the kind it was called with, and only that kind', async () => {
    recordConfirmedQuoteOvercharge('step');
    recordConfirmedQuoteOvercharge('step');
    recordConfirmedQuoteOvercharge('training');
    expect(await read('step')).toBe(2);
    expect(await read('training')).toBe(1);
  });

  it('🔴 DECLARES exactly one label, `kind`, over exactly two values', async () => {
    // Asserted against the DECLARED `labelNames`: prom-client omits a
    // declared-but-never-supplied label from its output, so inspecting emitted series
    // alone stays green while the metric is declared wide open.
    ensureRegisterAppBlockRuntimeMetrics();
    expect([...(metric() as Readable).labelNames]).toEqual(['kind']);
    expect([...APP_BLOCK_CONFIRMED_QUOTE_KINDS]).toEqual(['training', 'step']);

    for (let i = 0; i < 50; i++) {
      for (const kind of APP_BLOCK_CONFIRMED_QUOTE_KINDS) recordConfirmedQuoteOvercharge(kind);
    }
    const { values } = await (metric() as Readable).get();
    expect(values).toHaveLength(2);
    for (const v of values) expect(Object.keys(v.labels)).toEqual(['kind']);
  });

  it('🔴 the emitter NEVER throws — a broken registry cannot fail a charged submit', () => {
    // A name collision with a different label set: `inc({ kind })` would throw.
    new client.Counter({ name: METRIC, help: 'poisoned', labelNames: ['other'] });
    expect(() => recordConfirmedQuoteOvercharge('step')).not.toThrow();
  });
});
