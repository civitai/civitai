import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { runCoocRetentionSweep } from '~/server/services/resource-intent-cooc/heartbeat';
import { buildCoocSnapshot } from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { coocSqlOf } from '~/server/services/resource-intent-cooc/store';
import { createJob } from './job';

export const buildResourceIntentCoocJob = createJob(
  'build-resource-intent-cooc',
  // Weekly; COOC_PRODUCTION_RETENTION_DAYS is sized for this cadence.
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
  // A concurrent second build would repeat the whole replica draw (normally ending 'duplicate');
  // that load is the harm the held lock prevents. 90 min, not the 30 the screen's ~2 min draw
  // suggests, because the worst case (200 batches, each retried twice) runs past an hour and the
  // lock must outlive it; at a weekly cadence a long hold blocks nothing scheduled. The build does
  // not poll `checkIfCanceled`, so it finishes if the scheduler hangs up.
  { lockExpiration: 90 * 60, keepLockOnDisconnect: true }
);

/** Not behind the build flag: study pins must expire even while building is off. */
export const resourceIntentCoocRetentionJob = createJob(
  'resource-intent-cooc-retention',
  '30 4 * * *',
  async () => runCoocRetentionSweep(coocSqlOf(dbWrite), dbWrite, new Date())
);
