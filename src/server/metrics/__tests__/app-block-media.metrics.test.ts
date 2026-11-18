import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

const DEGRADED = 'civitai_app_block_media_serving_degraded_total';
const REFUSED = 'civitai_app_block_media_input_refused_total';
const UNLOCK = 'civitai_app_block_unlock_charged_not_released_total';

async function values(name: string, reg: Registry) {
  const metric = reg.getSingleMetric(name);
  if (!metric) return [];
  return (await metric.get()).values;
}

describe('host media safety counters', () => {
  it('a fresh registry publishes every label of the media and unlock counters at 0', async () => {
    const { seedAppBlockMediaMetrics } = await import('~/server/metrics/app-block-runtime.metrics');
    const reg = new Registry();
    seedAppBlockMediaMetrics(reg);

    const degraded = await values(DEGRADED, reg);
    expect(degraded.map((v) => v.labels.reason).sort()).toEqual(['eval_failed', 'no_session']);
    expect(degraded.every((v) => v.value === 0)).toBe(true);

    const refused = await values(REFUSED, reg);
    expect(refused.map((v) => v.labels.phase).sort()).toEqual(['estimate', 'submit']);
    expect(refused.every((v) => v.value === 0)).toBe(true);

    const unlock = await values(UNLOCK, reg);
    expect(unlock.map((v) => v.labels.read_back).sort()).toEqual(['failed', 'ok']);
    expect(unlock.every((v) => v.value === 0)).toBe(true);
  });

  it('CONTROL: without the seed, a registered counter publishes no series', async () => {
    const { ensureRegisterAppBlockRuntimeMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const reg = new Registry();
    ensureRegisterAppBlockRuntimeMetrics(reg);
    expect(await values(DEGRADED, reg)).toEqual([]);
    expect(await values(REFUSED, reg)).toEqual([]);
    expect(await values(UNLOCK, reg)).toEqual([]);
  });

  it('seeding again keeps a count already recorded', async () => {
    const { seedAppBlockMediaMetrics, ensureRegisterAppBlockRuntimeMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const reg = new Registry();
    ensureRegisterAppBlockRuntimeMetrics(reg).mediaInputRefusedTotal.inc({ phase: 'submit' });
    seedAppBlockMediaMetrics(reg);
    const refused = await values(REFUSED, reg);
    expect(refused.find((v) => v.labels.phase === 'submit')?.value).toBe(1);
  });
});

describe('the unlock charged-not-released counter', () => {
  it('a failed read-back counts as failed, a clean one as ok', async () => {
    const { recordBlockUnlockChargedNotReleased } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const { default: client } = await import('prom-client');
    const read = async (readBack: string) =>
      (await values(UNLOCK, client.register)).find((v) => v.labels.read_back === readBack)?.value ??
      0;
    const [ok, failed] = [await read('ok'), await read('failed')];
    recordBlockUnlockChargedNotReleased(true);
    expect(await read('failed')).toBe(failed + 1);
    expect(await read('ok')).toBe(ok);
  });
});
