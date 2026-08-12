import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { runAutoFeatureImages } from '~/server/services/auto-feature-images.service';
import { createJob, getJobDate } from './job';

// Wakes hourly but fires on the cadence in the home block's `autoFeature.intervalHours`, so the
// rate can be changed without a deploy. Default-off: isFlipt is false for an unknown flag or an
// unreachable Flipt, and the config's own `dryRun` defaults on, so two switches have to be
// thrown before this writes anything.
export const autoFeatureImages = createJob('auto-feature-images', '20 * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.AUTO_FEATURE_IMAGES))) return { reason: 'flag-off' };

  const [lastRun, setLastRun] = await getJobDate('job:auto-feature-images');
  const result = await runAutoFeatureImages({ lastRun });
  // Only a run that got as far as scoring counts as a run; a config or eligibility miss must not
  // push the next attempt an interval away.
  if ('picked' in result) await setLastRun();

  return result;
});
