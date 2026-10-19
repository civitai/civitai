import type { NextApiResponse } from 'next';
import { creatorServiceDealFileJobs } from '~/server/jobs/creator-service-deal-file-jobs';
import { creatorServiceDealJobs } from '~/server/jobs/creator-service-deal-jobs';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

// [DO NOT MERGE] Demo-only: PR previews run no scheduled jobs, so a moderator runs the Creator
// Services jobs once from here (GET too, so it runs from the address bar). Answers 404 anywhere
// but this PR's preview deployment.
const isDemoPreview = () =>
  process.env.IS_PREVIEW === 'true' && process.env.CACHE_KEY_NAMESPACE === 'preview';

const jobs = [...creatorServiceDealFileJobs, ...creatorServiceDealJobs];

export default ModEndpoint(
  async (_req, res: NextApiResponse) => {
    if (!isDemoPreview()) return res.status(404).json({ error: 'Not found' });
    const results: Record<string, unknown> = {};
    for (const job of jobs) {
      try {
        results[job.name] = (await job.run().result) ?? null;
      } catch (error) {
        results[job.name] = { error: (error as Error).message };
      }
    }
    return res.status(200).json(results);
  },
  ['GET', 'POST']
);
