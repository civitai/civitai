import client from 'prom-client';
import { describe, expect, it } from 'vitest';

import {
  APP_BLOCK_BUILDS_METRIC,
  ensureRegisterAppBlockBuildMetrics,
  recordAppBlockBuildOutcome,
} from '~/server/prom/app-block-build.metrics';

/**
 * `civitai_app_block_builds_total`. Read back off the DEFAULT registry, the one
 * `/api/metrics` serves, so a counter registered anywhere else fails here.
 */

type Row = { value: number; labels: Record<string, string> };

async function rows(): Promise<Row[]> {
  const metric = client.register.getSingleMetric(APP_BLOCK_BUILDS_METRIC) as unknown as
    | { get(): Promise<{ values: Row[] }> }
    | undefined;
  return metric ? (await metric.get()).values : [];
}

const key = (l: Record<string, string>) =>
  `${l.mode}/${l.outcome}/${l.failed_step}/${l.failure_class}`;

describe('civitai_app_block_builds_total', () => {
  it('publishes the series at 0 before any build reports', async () => {
    ensureRegisterAppBlockBuildMetrics();
    const seeded = await rows();
    expect(seeded.find((r) => key(r.labels) === 'build/failed/build/transient')?.value).toBe(0);
  });

  it('drops a label value outside its closed set instead of creating a series', async () => {
    const before = (await rows()).length;
    recordAppBlockBuildOutcome({
      mode: 'build',
      outcome: 'failed',
      failedStep: 'my-app' as never,
      failureClass: 'unknown',
    });
    recordAppBlockBuildOutcome({
      mode: 'build',
      outcome: 'failed',
      failedStep: 'scan',
      failureClass: 'someone' as never,
    });
    expect((await rows()).length).toBe(before);
  });
});
