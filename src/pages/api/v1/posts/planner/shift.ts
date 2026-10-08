import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import {
  createPlannerCaller,
  handlePlannerError,
  requireJsonBody,
} from '~/server/utils/planner-endpoint';
import type { SessionUser } from '~/types/session';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      if (!requireJsonBody(req, res)) return;
      const result = await createPlannerCaller(req, res, user).post.shiftSchedule(req.body ?? {});
      return res.status(200).json(result);
    } catch (error) {
      return handlePlannerError(res, error);
    }
  },
  ['POST']
);
