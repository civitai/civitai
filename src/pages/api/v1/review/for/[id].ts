import { NextApiRequest, NextApiResponse } from 'next';

import { SessionUser } from 'next-auth';
import { authedApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const apiCaller = appRouter.createCaller(authedApiContext(req, res, user));
    res.send(
      await apiCaller.resourceReview.getUserResourceReview({ modelVersionId: Number(req.query.id) })
    );
  },
  ['GET']
);
