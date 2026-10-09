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
  it('seeds exactly the reachable label sets at 0 — the class table, both modes', async () => {
    ensureRegisterAppBlockBuildMetrics();
    const seeded = (await rows()).map((r) => key(r.labels)).sort();
    const perMode = [
      'succeeded/none/none',
      'failed/clone/platform',
      'failed/validate/author',
      'failed/build/unknown',
      'failed/build/transient',
      'failed/scan/unknown',
      'failed/push/transient',
      'failed/none/unknown',
      'failed/apply/platform',
      'failed/unreported/unknown',
    ];
    expect(seeded).toEqual(
      ['build', 'review'].flatMap((m) => perMode.map((s) => `${m}/${s}`)).sort()
    );
    // No slug / sha / run label exists to grow it.
    expect(Object.keys((await rows())[0].labels).sort()).toEqual([
      'failed_step',
      'failure_class',
      'mode',
      'outcome',
    ]);
  });

  it('counts one outcome on its own series', async () => {
    const get = async () =>
      (await rows()).find((r) => key(r.labels) === 'review/failed/push/transient')?.value ?? 0;
    const before = await get();
    recordAppBlockBuildOutcome({
      mode: 'review',
      outcome: 'failed',
      failedStep: 'push',
      failureClass: 'transient',
    });
    expect((await get()) - before).toBe(1);
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
