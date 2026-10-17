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
  // A concurrent second build would repeat every read. 90 min outlives a full build with retried
  // statements (docs/resource-intent-primitive.md, "Build job"); at a weekly cadence a long hold
  // blocks nothing. The build does not poll `checkIfCanceled`, so it finishes if the scheduler hangs
  // up.
  { lockExpiration: 90 * 60, keepLockOnDisconnect: true }
);
