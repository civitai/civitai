import { NextApiRequest, NextApiResponse } from 'next';

import { SessionUser } from 'next-auth';
import { authedApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const apiCaller = appRouter.createCaller(authedApiContext(req, res, user));
    if (req.method === 'GET') {
      return res.send(await apiCaller.resourceReview.get({ id: Number(req.query.id) }));
    }

    if (req.method === 'POST') {
      const input = { ...req.body, id: Number(req.query.id) };
      return res.send(await apiCaller.resourceReview.update(input));
    }
  },
  ['POST', 'GET']
);
