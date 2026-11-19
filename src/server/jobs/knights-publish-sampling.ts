import { kyselyWrite } from '~/server/db/kyselyDb';
import { logToAxiom } from '~/server/logging/client';
import { getKnightsSourcesConfig } from '~/server/services/knights/sources';
import { sampleNewlyLivePostsForKnights } from '~/server/services/knights/sampling';
import { createJob, getJobDate } from './job';

const JOB_NAME = 'knights-publish-sampling';

/**
 * Samples images into the Knights queue once their post goes live, whatever set `publishedAt` (an owner's publish, a
 * scheduled date arriving, a model, version or collection publish). Scan-time sampling only takes images already live.
 * The cursor is this job's own date (`getJobDate`), advanced only after a run completes, so a failed run is retried.
 */
export const knightsPublishSampling = createJob(JOB_NAME, '*/1 * * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate(JOB_NAME);
  const config = await getKnightsSourcesConfig();
  // primary: a replica behind the window's end would let posts slip past the cursor for good.
  const result = await sampleNewlyLivePostsForKnights(kyselyWrite, {
    since: lastRun,
    now: new Date(),
    config,
  });
  if (result.skippedTies)
    logToAxiom(
      { type: 'knights-v2-publish-sample-ties', cursor: result.cursor.toISOString() },
      'knights-v2-sources'
    );
  await setLastRun(result.cursor);
  return { ...result, cursor: result.cursor.toISOString() };
});
