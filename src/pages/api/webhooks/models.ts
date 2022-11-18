import { NextApiRequest, NextApiResponse } from 'next';
import { appRouter } from '~/server/routers';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const apiCaller = appRouter.createCaller({ user: undefined });
  const reqApiKey = req.headers['x-civitai-api-key'] as string;

  // TODO: how do we retrieve te correct key???
  const results = await apiCaller.apiKey.verifyKey({ key: reqApiKey });
  if (!results.success) return res.status(403).send('You are not authorized to do this action');

  return await apiCaller.model.getAll({});
}
