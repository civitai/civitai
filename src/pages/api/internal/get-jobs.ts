import { NextApiRequest, NextApiResponse } from 'next';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';
import { jobs } from '~/pages/api/webhooks/run-jobs/[[...run]]';

export default JobEndpoint(async function getJobs(req: NextApiRequest, res: NextApiResponse) {
  return res.status(200).json(Array.from(jobs));
});
