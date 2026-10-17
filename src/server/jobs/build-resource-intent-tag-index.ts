import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { runTagIndexBuild } from '~/server/services/resource-intent-tags/pipeline';
import { createJob } from './job';

export const buildResourceIntentTagIndexJob = createJob(
  'build-resource-intent-tag-index',
  // Weekly, an hour after build-resource-intent-cooc ('0 5 * * 2').
  '0 6 * * 2',
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD)))
      return { skipped: 'flag off' };
    const { summary } = await runTagIndexBuild({ dryRun: false }, { env });
    return summary;
  },
  // A concurrent second build would repeat every read (ending in the same snapshot at best). The
  // build measured ~35 min end to end in its dry run; 90 min outlives it with room for retried
  // statements, and at a weekly cadence a long hold blocks nothing scheduled. The build does not
  // poll `checkIfCanceled`, so it finishes if the scheduler hangs up.
  { lockExpiration: 90 * 60, keepLockOnDisconnect: true }
);
