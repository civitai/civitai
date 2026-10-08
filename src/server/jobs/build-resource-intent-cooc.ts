import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { runCoocRetentionSweep } from '~/server/services/resource-intent-cooc/heartbeat';
import { buildCoocSnapshot } from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { coocSqlOf } from '~/server/services/resource-intent-cooc/store';
import { createJob } from './job';

export const buildResourceIntentCoocJob = createJob(
  'build-resource-intent-cooc',
  // Weekly: production retention keeps four weeks of builds, which assumes this cadence.
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
  // A second concurrent build would draw and count the same window twice for nothing; the build
  // does not poll `checkIfCanceled`, so it finishes even if the scheduler hangs up.
  { lockExpiration: 30 * 60, keepLockOnDisconnect: true }
);

/**
 * Deliberately NOT behind the build flag: study pins must expire, and old builds be deleted, even
 * while building is switched off. Daily, because the 58-day pin cap plus a ~26 h heartbeat
 * staleness alert is what keeps a study row from reaching 60 days unnoticed.
 */
export const resourceIntentCoocRetentionJob = createJob(
  'resource-intent-cooc-retention',
  '30 4 * * *',
  async () => runCoocRetentionSweep(coocSqlOf(dbWrite), dbWrite, new Date())
);
