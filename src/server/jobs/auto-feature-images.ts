import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
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
  // The flag being on is a statement of intent, so every bail below it is a fault rather than an
  // off switch — and each one is otherwise indistinguishable from the job working. A missing config
  // went unnoticed for three days once. `interval-not-elapsed` is the one that means "working",
  // which caps this at the cron's 24/day.
  if ('reason' in result && result.reason !== 'interval-not-elapsed')
    logToAxiom({ type: 'job-misconfigured', name: 'auto-feature-images', reason: result.reason });
  // Only a run that got as far as scoring counts as a run; a config or eligibility miss must not
  // push the next attempt an interval away.
  if ('picked' in result) await setLastRun();

  // What the caps did with this run. `job-summary` is the existing vocabulary for this
  // (`image-ingestion.ts`), and it is emitted on EVERY run rather than only a short one: a healthy
  // run and a dead job must not produce the same evidence.
  //
  // ⚠️ It cannot detect the job not running at all — the 79-hour silence in August emitted nothing
  // from anywhere, and nothing logged from inside a run ever will. That needs a separate health
  // check against the collection's own state; filed as 868kz3ef5, with challenge-health-check.ts
  // as the precedent.
  if ('picked' in result)
    logToAxiom({
      type: 'job-summary',
      name: 'auto-feature-images',
      target: result.target,
      picked: result.picked,
      scored: result.scored,
      candidates: result.candidates,
      blockedByRunCap: result.blocked.creatorRun,
      blockedByCreatorCap: result.blocked.creatorWindow,
      blockedByCollectionCap: result.blocked.collectionWindow,
    }).catch(() => null);

  return result;
});
