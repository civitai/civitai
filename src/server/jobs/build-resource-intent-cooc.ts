import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { runCoocRetentionSweep } from '~/server/services/resource-intent-cooc/heartbeat';
import { buildCoocSnapshot } from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { coocSqlOf } from '~/server/services/resource-intent-cooc/store';
import { createJob } from './job';

export const buildResourceIntentCoocJob = createJob(
  'build-resource-intent-cooc',
  // Weekly; COOC_PRODUCTION_RETENTION_DAYS (28) is sized for this cadence.
  '0 5 * * 2',
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_COOC_BUILD)))
      return { skipped: 'flag off' };
    return buildCoocSnapshot({
      kind: 'production',
      seed: RESOURCE_INTENT_COOC_SPEC.defaultSeed,
      pinnedUntil: null,
      dryRun: false,
    });
  },
  // A concurrent second build would draw the same window again and end as a 'duplicate' row, so
  // the lock saves replica load, not correctness. 90 min covers a worst-case draw (200 batches with
  // retries). The build does not poll `checkIfCanceled`, so it finishes if the scheduler hangs up.
  { lockExpiration: 90 * 60, keepLockOnDisconnect: true }
);

/** Not behind the build flag: study pins must expire even while building is off. */
export const resourceIntentCoocRetentionJob = createJob(
  'resource-intent-cooc-retention',
  '30 4 * * *',
  async () => runCoocRetentionSweep(coocSqlOf(dbWrite), dbWrite, new Date())
);
